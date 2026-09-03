import "fake-indexeddb/auto";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalVault,
  addAttachment,
  synchronize,
  resolveConflicts,
  hasUnsyncedChanges,
} from "../src/local";
import { encodeAttachment, attachmentChoiceKey } from "../src/core/attachments";
import { changeSchema } from "../src/core/contracts";
import { FileStore, ConflictError } from "../server/store";
import { MarkdownPreview } from "../src/MarkdownPreview";
import { attachmentBlob } from "../src/attachment-files";

const note = "raw/Inbox/a.md",
  media = "raw/Inbox/a.assets/图 #1.png";
const first = encodeAttachment(new Uint8Array([0, 255, 1])),
  second = encodeAttachment(new Uint8Array([2, 255, 0]));
const databases: LocalVault[] = [];
async function fixture() {
  const parent = path.resolve(".prototype-data/tests");
  await fs.mkdir(parent, { recursive: true });
  const store = new FileStore(
    await fs.mkdtemp(path.join(parent, "binary-client-")),
  );
  await store.init(false);
  const base = await store.commit({
    requestId: "text-seed",
    expectedRevision: (await store.snapshot()).revision,
    files: { [note]: "# A" },
  });
  const db = new LocalVault("attachments-" + crypto.randomUUID());
  databases.push(db);
  const row = await db.read();
  await db.update(row.version, (r) => ({
    ...r,
    files: base.files,
    attachments: {},
    base,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init?: RequestInit) => {
      if (url === "/api/snapshot") return Response.json(await store.snapshot());
      try {
        return Response.json(
          await store.commit(
            changeSchema.parse(JSON.parse(String(init?.body))),
          ),
        );
      } catch (error) {
        if (error instanceof ConflictError)
          return Response.json({ snapshot: error.snapshot }, { status: 409 });
        throw error;
      }
    }),
  );
  return { db, store };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) {
    db.close();
    await db.delete();
  }
});
describe("offline binary client", () => {
  it("atomically adds bytes with an escaped readable reference, reopens and synchronizes", async () => {
    const { db, store } = await fixture();
    const row = await db.read();
    const imported = await addAttachment(
      db,
      row.version,
      note,
      "图 #1.png",
      new Uint8Array([0, 255, 1]),
    );
    expect(imported.files[note]).toContain("%20%231.png");
    expect(imported.attachments?.[media]).toEqual(first);
    expect(hasUnsyncedChanges(imported)).toBe(true);
    db.close();
    await db.open();
    expect((await db.read()).attachments?.[media]).toEqual(first);
    const after = await synchronize(db);
    expect(hasUnsyncedChanges(after)).toBe(false);
    expect((await store.snapshot()).attachments?.[media]).toEqual(first);
  });
  it("rejects duplicate files, invalid names and stale-tab imports without mutating saved content", async () => {
    const { db } = await fixture();
    const old = await db.read();
    const row = await addAttachment(
      db,
      old.version,
      note,
      "图 #1.png",
      new Uint8Array([0, 255, 1]),
    );
    await expect(
      addAttachment(db, old.version, note, "another.png", new Uint8Array()),
    ).rejects.toThrow("标签页");
    await expect(
      addAttachment(db, row.version, note, "图 #1.png", new Uint8Array()),
    ).rejects.toThrow("同名附件");
    await expect(
      addAttachment(db, row.version, note, "../a.png", new Uint8Array()),
    ).rejects.toThrow("目录");
    await expect(
      addAttachment(db, row.version, note, "a.svg", new Uint8Array()),
    ).rejects.toThrow();
    expect(await db.read()).toEqual(row);
  });
  it("rolls back both the note reference and attachment when local storage fails", async () => {
    const { db } = await fixture();
    const row = await db.read();
    const fail = () => {
      throw new Error("quota simulated");
    };
    db.vault.hook("updating", fail);
    await expect(
      addAttachment(db, row.version, note, "image.png", new Uint8Array([1])),
    ).rejects.toThrow("quota");
    db.vault.hook("updating").unsubscribe(fail);
    expect(await db.read()).toEqual(row);
  });
  it("keeps the exact pending attachment request after receipt loss, preserving a newer local edit", async () => {
    const { db, store } = await fixture();
    await addAttachment(
      db,
      (await db.read()).version,
      note,
      "图 #1.png",
      new Uint8Array([0, 255, 1]),
    );
    let lost = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init?: RequestInit) => {
        if (url === "/api/snapshot")
          return Response.json(await store.snapshot());
        lost = String(init?.body);
        await store.commit(changeSchema.parse(JSON.parse(lost)));
        throw new Error("lost receipt");
      }),
    );
    await expect(synchronize(db)).rejects.toThrow("lost receipt");
    const waiting = await db.read();
    await db.update(waiting.version, (r) => ({
      ...r,
      attachments: { [media]: second },
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) => {
        expect(String(init?.body)).toBe(lost);
        return Response.json(
          await store.commit(changeSchema.parse(JSON.parse(lost))),
        );
      }),
    );
    const result = await synchronize(db);
    expect(result.attachments?.[media]).toEqual(second);
    expect(result.base?.attachments?.[media]).toEqual(first);
    expect(hasUnsyncedChanges(result)).toBe(true);
  });
  it("persists attachment conflicts, requires a choice and backs up both alternatives before resolving", async () => {
    const { db, store } = await fixture();
    await addAttachment(
      db,
      (await db.read()).version,
      note,
      "图 #1.png",
      new Uint8Array([0, 255, 1]),
    );
    const synced = await synchronize(db);
    await db.update(synced.version, (r) => ({
      ...r,
      attachments: { [media]: second },
    }));
    const remote = await store.snapshot();
    await store.commit({
      protocolVersion: 2,
      requestId: "remote-delete",
      expectedRevision: remote.revision,
      files: remote.files,
      attachments: {},
    });
    const conflict = await synchronize(db);
    expect(conflict.conflict?.items).toEqual([]);
    expect(conflict.conflict?.attachmentItems).toHaveLength(1);
    db.close();
    await db.open();
    await expect(resolveConflicts(db, await db.read(), {})).rejects.toThrow(
      "附件冲突",
    );
    expect(await db.recovery.count()).toBe(0);
    const resolved = await resolveConflicts(db, await db.read(), {
      [attachmentChoiceKey(media)]: "remote",
    });
    expect(resolved.attachments).toEqual({});
    expect((await db.recovery.toArray())[0].state.attachments?.[media]).toEqual(
      second,
    );
    expect(
      (await db.recovery.toArray())[0].state.conflict?.attachmentItems?.[0]
        .remote,
    ).toBeNull();
  });
  it("aligns locally edited bytes and newly added attachments across a server-side note move", async () => {
    const { db, store } = await fixture();
    await addAttachment(
      db,
      (await db.read()).version,
      note,
      "图 #1.png",
      new Uint8Array([0, 255, 1]),
    );
    const row = await synchronize(db);
    await db.update(row.version, (r) => ({
      ...r,
      attachments: { ...r.attachments, [media]: second },
    }));
    await addAttachment(
      db,
      (await db.read()).version,
      note,
      "new.mp4",
      new Uint8Array([0, 1, 255]),
    );
    await store.move({
      protocolVersion: 2,
      requestId: "remote-relocation",
      expectedRevision: (await store.snapshot()).revision,
      from: note,
      to: "raw/Areas/b.md",
    });
    const result = await synchronize(db);
    expect(result.conflict).toBeNull();
    expect(result.attachments?.["raw/Areas/b.assets/图 #1.png"]).toEqual(
      second,
    );
    expect(result.attachments?.["raw/Areas/b.assets/new.mp4"]).toBeTruthy();
    expect(result.files["raw/Areas/b.md"]).toContain(
      "raw/Areas/b.assets/new.mp4",
    );
    expect((await store.snapshot()).attachments).toEqual(result.attachments);
  });
  it("rejects future or unversioned binary snapshots without replacing drafts", async () => {
    const { db } = await fixture(),
      row = await db.read();
    for (const protocolVersion of [99, undefined]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            revision: "future",
            files: row.files,
            protocolVersion,
            attachments: { [media]: first },
          }),
        ),
      );
      await expect(synchronize(db)).rejects.toThrow("协议");
      expect(await db.read()).toEqual(row);
    }
  });
});
describe("local-only attachment rendering", () => {
  const render = (source: string, files = { [note]: source }) =>
    renderToStaticMarkup(
      <MarkdownPreview
        source={source}
        owner={note}
        files={files}
        attachments={{ [media]: first }}
        onOpen={() => {
          throw new Error("No navigation during render");
        }}
      />,
    );
  it("resolves Markdown images, Wiki embeds and explicit attachment links", () => {
    for (const source of [
      "![图](a.assets/图%20%231.png)",
      "![[a.assets/图%20%231.png]]",
      "[附件](a.assets/图%20%231.png)",
    ]) {
      const html = render(source);
      expect(html).toContain(`data-attachment-path="${media}"`);
      expect(html).toContain("下载附件：");
      expect(html).not.toContain('src="http');
    }
  });
  it("retains attachment origin inside a transcluded document", () => {
    const host = "raw/Areas/overview.md";
    const html = renderToStaticMarkup(
      <MarkdownPreview
        source={`![[${note}]]`}
        owner={host}
        files={{
          [host]: `![[${note}]]`,
          [note]:
            "![图](a.assets/图%20%231.png)\n\n![[a.assets/图%20%231.png]]",
        }}
        attachments={{ [media]: first }}
        onOpen={() => {}}
      />,
    );
    expect(html.match(/data-attachment-path=/g)).toHaveLength(2);
  });
  it("never fetches remote media, raw HTML or forged blob/data URLs from Markdown", () => {
    const html = render(
      '![外部](https://example.org/tracker.png)\n\n![伪造](blob:foreign)\n\n![数据](data:image/svg+xml,test)\n\n<video src="https://example.org/movie.mp4"></video>',
    );
    expect(html).not.toMatch(/<(img|video|audio|iframe)\b/);
    expect(html).not.toContain("data-attachment-path");
  });
  it("creates a typed local Blob with unchanged bytes for download/preview", async () => {
    const blob = attachmentBlob(media, first);
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 1]),
    );
  });
  it("bounds repeated media across Markdown, references and Wiki embeds", () => {
    for (const source of [
      "![图](a.assets/图%20%231.png)",
      "![[a.assets/图%20%231.png]]",
      "![图][asset]",
    ]) {
      const html = render(
        Array.from({ length: 25 }, () => source).join("\n\n") +
          "\n\n[asset]: a.assets/图%20%231.png",
      );
      expect(html.match(/data-attachment-path=/g)).toHaveLength(24);
      expect(html).toContain("媒体预览超过上限");
    }
  });
  it("shares the decoded-media byte budget with transcluded notes", () => {
    const source = Array.from(
      { length: 10 },
      () => "![[a.assets/图%20%231.png]]",
    ).join("\n\n");
    const html = renderToStaticMarkup(
      <MarkdownPreview
        source={`![[${note}]]`}
        owner="raw/Areas/overview.md"
        files={{ [note]: source, "raw/Areas/overview.md": `![[${note}]]` }}
        attachments={{ [media]: encodeAttachment(new Uint8Array(1_000_000)) }}
        onOpen={() => {}}
      />,
    );
    expect(html.match(/data-attachment-path=/g)).toHaveLength(8);
    expect(html).toContain("媒体预览超过上限");
  });
});
