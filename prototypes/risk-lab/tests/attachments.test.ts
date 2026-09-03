import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore } from "../server/store";
import { restorePrototype } from "../server/restore";
import {
  encodeAttachment,
  decodeAttachment,
  attachmentSchema,
  attachmentChoiceKey,
  mergeAttachments,
  resolveAttachments,
  type Attachment,
} from "../src/core/attachments";
import { validateContent } from "../src/core/contracts";
import { alignMoves } from "../src/core/moves";

const note = "raw/Inbox/a.md",
  media = "raw/Inbox/a.assets/图片.png";
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
const asset = encodeAttachment(bytes),
  other = encodeAttachment(new Uint8Array([255, 0, 33]));
async function fixture() {
  const parent = path.resolve(".prototype-data/tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "attachments-"));
  const store = new FileStore(root);
  await store.init(false);
  const initial = await store.snapshot();
  const before = await store.commit({
    protocolVersion: 2,
    attachments: { [media]: asset },
    files: { [note]: "![图片](a.assets/图片.png)" },
    expectedRevision: initial.revision,
    requestId: "binary-seed",
  });
  return {
    root,
    store,
    before,
    request: {
      protocolVersion: 2 as const,
      attachments: { [media]: other },
      files: { [note]: "updated" },
      expectedRevision: before.revision,
      requestId: "binary-update",
    },
  };
}
describe("portable binary content", () => {
  it("roundtrips all byte values without text decoding and handles empty files", () => {
    expect(decodeAttachment(asset)).toEqual(bytes);
    expect(decodeAttachment(encodeAttachment(new Uint8Array()))).toEqual(
      new Uint8Array(),
    );
    expect(() => encodeAttachment(new Uint8Array(1_000_001))).toThrow("1 MB");
  });
  it.each(["YQ", "YR==", "YQ==\n", "!!!!", "=AAA", "YQ==="])(
    "rejects noncanonical Base64 %s",
    (data) => {
      expect(() =>
        attachmentSchema.parse({ encoding: "base64", data }),
      ).toThrow();
    },
  );
  it("rejects ambiguous paths, unknown binary formats and combined limits", () => {
    expect(() => validateContent({ [media]: "text" })).toThrow("文本");
    expect(() => validateContent({}, { "raw/Inbox/a.png": asset })).toThrow();
    expect(() =>
      validateContent({}, { "raw/Inbox/a.assets/a.html": asset }),
    ).toThrow();
    expect(() =>
      validateContent({ [media]: "text" }, { [media]: asset }),
    ).toThrow("重叠");
    expect(() =>
      validateContent({ "raw/Inbox/a.assets": "file" }, { [media]: asset }),
    ).toThrow("冲突");
    expect(() =>
      validateContent(
        {},
        { [media]: asset, "raw/inbox/a.assets/other.png": asset },
      ),
    ).toThrow();
    const large = encodeAttachment(new Uint8Array(1_000_000));
    expect(() =>
      validateContent(
        {},
        Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [
            `raw/Inbox/a.assets/${i}.png`,
            large,
          ]),
        ),
      ),
    ).toThrow("总量");
  });
  it("merges independent binary changes and presents overlapping edits as whole-file choices", () => {
    const base = { [media]: asset },
      local = { [media]: other },
      remote = {};
    const plan = mergeAttachments(base, local, remote);
    expect(plan.conflicts).toHaveLength(1);
    expect(() =>
      resolveAttachments(plan.attachments, plan.conflicts, {}),
    ).toThrow("选择");
    expect(
      resolveAttachments(plan.attachments, plan.conflicts, {
        [attachmentChoiceKey(media)]: "local",
      }),
    ).toEqual(local);
    expect(
      resolveAttachments(plan.attachments, plan.conflicts, {
        [attachmentChoiceKey(media)]: "remote",
      }),
    ).toEqual({});
    expect(mergeAttachments(base, base, local).attachments).toEqual(local);
    expect(
      mergeAttachments(base, local, structuredClone(local)).conflicts,
    ).toEqual([]);
  });
});
describe("journaled binary storage", () => {
  it("writes original bytes, upgrades the marker, reopens and retries an exact receipt", async () => {
    const { root, store, before, request } = await fixture();
    expect(new Uint8Array(await fs.readFile(path.join(root, media)))).toEqual(
      bytes,
    );
    expect(await fs.readFile(path.join(root, ".risk-lab"), "utf8")).toBe(
      "risk-lab-v2",
    );
    const reopened = new FileStore(root);
    await reopened.init(false);
    expect(await reopened.snapshot()).toEqual(before);
    const after = await store.commit(request);
    expect(after.revision).not.toBe(before.revision);
    expect(await store.commit(request)).toEqual(after);
    await expect(
      store.commit({ ...request, attachments: { [media]: asset } }),
    ).rejects.toThrow("幂等");
  });
  it("rejects old-client commits and moves without losing attachments", async () => {
    const { store, before } = await fixture();
    for (const extra of [{}, { protocolVersion: 2 as const }]) {
      await expect(
        store.commit({
          ...extra,
          files: before.files,
          requestId: "old-client",
          expectedRevision: before.revision,
        }),
      ).rejects.toThrow("旧文本快照");
    }
    await expect(
      store.move({
        requestId: "old-movement",
        expectedRevision: before.revision,
        from: note,
        to: "raw/Areas/b.md",
      }),
    ).rejects.toThrow("升级客户端");
    expect(await store.snapshot()).toEqual(before);
  });
  it.each([1, 2, "prepared", "files", "ledger", "moves", "committed"] as const)(
    "recovers text and binary consistently after %s",
    async (point) => {
      const { root, before, request } = await fixture();
      const failing = new FileStore(root, point);
      await failing.init(false);
      await expect(failing.commit(request)).rejects.toThrow("INJECTED_CRASH");
      const reopened = new FileStore(root);
      await reopened.init(false);
      const snapshot = await reopened.snapshot();
      expect(snapshot.files[note]).toBe(
        point === "committed" ? "updated" : before.files[note],
      );
      expect(snapshot.attachments?.[media]).toEqual(
        point === "committed" ? other : asset,
      );
      expect(new Uint8Array(await fs.readFile(path.join(root, media)))).toEqual(
        decodeAttachment(snapshot.attachments![media]),
      );
    },
  );
  it("refuses recovery over external binary changes", async () => {
    const { root, request } = await fixture();
    const failing = new FileStore(root, "files");
    await failing.init(false);
    await expect(failing.commit(request)).rejects.toThrow();
    const external = new Uint8Array([13, 14, 15, 255]);
    await fs.writeFile(path.join(root, media), external);
    await expect(new FileStore(root).init(false)).rejects.toThrow(
      "外部附件修改",
    );
    expect(new Uint8Array(await fs.readFile(path.join(root, media)))).toEqual(
      external,
    );
  });
  it("moves attachment paths and incoming links together, preserving raw bytes", async () => {
    const { store, root, before } = await fixture();
    const moved = await store.move({
      protocolVersion: 2,
      requestId: "binary-move",
      expectedRevision: before.revision,
      from: note,
      to: "raw/Areas/b.md",
    });
    const newMedia = "raw/Areas/b.assets/图片.png";
    expect(moved.attachments?.[newMedia]).toEqual(asset);
    expect(moved.files["raw/Areas/b.md"]).toBe("![图片](b.assets/图片.png)");
    expect(
      new Uint8Array(await fs.readFile(path.join(root, newMedia))),
    ).toEqual(bytes);
    const aligned = alignMoves(before, before.files, moved, {
      [media]: other,
      "raw/Inbox/a.assets/new.mp4": asset,
    });
    expect(aligned.attachments[newMedia]).toEqual(other);
    expect(aligned.attachments["raw/Areas/b.assets/new.mp4"]).toEqual(asset);
    expect(aligned.baseAttachments[newMedia]).toEqual(asset);
  });
  it("does not overwrite an occupied attachment destination during a move", async () => {
    const { store, before } = await fixture();
    const seeded = await store.commit({
      protocolVersion: 2,
      attachments: {
        ...before.attachments,
        "raw/Areas/b.assets/图片.png": other,
      },
      files: before.files,
      expectedRevision: before.revision,
      requestId: "collision-seed",
    });
    await expect(
      store.move({
        protocolVersion: 2,
        requestId: "collision-move",
        expectedRevision: seeded.revision,
        from: note,
        to: "raw/Areas/b.md",
      }),
    ).rejects.toThrow("目标已存在");
    expect(await store.snapshot()).toEqual(seeded);
  });
  it.each(["minimal", "standard", "full"] as const)(
    "restores original media bytes from a %s backup into a new directory",
    async (tier) => {
      const { root, store, before } = await fixture();
      const target = root + "-restored";
      await restorePrototype(root, target, tier);
      const restored = new FileStore(target);
      await restored.init(false);
      expect((await restored.snapshot()).attachments).toEqual(
        before.attachments,
      );
      expect(
        new Uint8Array(await fs.readFile(path.join(target, media))),
      ).toEqual(bytes);
      expect(await store.snapshot()).toEqual(before);
    },
  );
  it("recovers interrupted attachment changes only inside the full restored copy", async () => {
    const { root, before, request } = await fixture();
    const failing = new FileStore(root, "files");
    await failing.init(false);
    await expect(failing.commit(request)).rejects.toThrow();
    const target = root + "-restored";
    await restorePrototype(root, target, "full");
    expect((await new FileStore(target).snapshot()).attachments).toEqual(
      before.attachments,
    );
    expect(new Uint8Array(await fs.readFile(path.join(root, media)))).toEqual(
      decodeAttachment(other),
    );
    expect(await fs.stat(path.join(root, "state/journal.json"))).toBeTruthy();
  });
});
