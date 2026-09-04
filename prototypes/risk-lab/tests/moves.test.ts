import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FileStore, ConflictError } from "../server/store";
import {
  LocalVault,
  resolveConflicts,
  synchronize,
  hasUnsyncedChanges,
} from "../src/local";
import { alignMoves } from "../src/core/moves";
import { moveNote } from "../src/core/paths";
import {
  parseOpml,
  serializeOpml,
  serializeRelations,
  topic,
} from "../src/core/formats";
import {
  type Snapshot,
  type MoveRecord,
  validateFiles,
} from "../src/core/contracts";

const a = "raw/Inbox/a.md",
  b = "raw/Areas/b.md",
  c = "raw/Projects/c.md",
  ref = "raw/Areas/ref.md";
const record = (sequence = 1, from = a, to = b): MoveRecord => ({
  sequence,
  from,
  to,
  at: "2026-09-03T00:00:00.000Z",
});
const snapshot = (
  files: Record<string, string>,
  moves: MoveRecord[] = [],
): Snapshot => ({ revision: "fixture", files, moves });
const databases: LocalVault[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) {
    db.close();
    await db.delete();
  }
});
async function fixture() {
  const parent = path.resolve(".prototype-data/tests");
  await fs.mkdir(parent, { recursive: true });
  const store = new FileStore(await fs.mkdtemp(path.join(parent, "moves-")));
  await store.init(false);
  const base = await store.commit({
    requestId: crypto.randomUUID(),
    expectedRevision: (await store.snapshot()).revision,
    files: { [a]: "top\n\ngap\n\nbottom", [ref]: "[[raw/Inbox/a#标题|引用]]" },
  });
  const db = new LocalVault("move-test-" + crypto.randomUUID());
  databases.push(db);
  const row = await db.read();
  await db.update(row.version, (r) => ({ ...r, files: base.files, base }));
  const api = async (url: unknown, init?: RequestInit) => {
    try {
      return Response.json(
        url === "/api/commit"
          ? await store.commit(JSON.parse(String(init?.body)))
          : await store.snapshot(),
      );
    } catch (e) {
      if (e instanceof ConflictError)
        return Response.json({ snapshot: e.snapshot }, { status: 409 });
      throw e;
    }
  };
  vi.stubGlobal("fetch", api);
  return { store, db, base, api };
}

describe("readable movement replay", () => {
  it("moves an arbitrary-depth folder and rewrites its document references", () => {
    const source = {
      "raw/Areas/健康/睡眠/记录.md": "[[raw/Areas/健康/睡眠/结论]]",
      "raw/Areas/健康/睡眠/结论.md": "结论",
      "raw/Projects/计划.md": "[[raw/Areas/健康/睡眠/记录]]",
    };
    const moved = moveNote(
      source,
      "raw/Areas/健康/睡眠",
      "raw/Projects/减脂/睡眠",
      true,
      ["raw/Areas/健康/睡眠/记录.assets/图.png"],
    );
    expect(moved.files["raw/Areas/健康/睡眠/记录.md"]).toBeUndefined();
    expect(moved.files["raw/Projects/减脂/睡眠/记录.md"]).toBe(
      "[[raw/Projects/减脂/睡眠/结论]]",
    );
    expect(moved.files["raw/Projects/计划.md"]).toBe(
      "[[raw/Projects/减脂/睡眠/记录]]",
    );
    expect(moved.moves["raw/Areas/健康/睡眠/记录.assets/图.png"]).toBe(
      "raw/Projects/减脂/睡眠/记录.assets/图.png",
    );
  });
  it("refuses to move a folder into its own descendant", () => {
    expect(() =>
      moveNote(
        { "raw/Areas/健康/睡眠/记录.md": "内容" },
        "raw/Areas/健康",
        "raw/Areas/健康/睡眠/归档",
      ),
    ).toThrow("自身内部");
  });
  it("replays a chain on both baseline and local changes, including references", () => {
    const base = snapshot({ [a]: "original", [ref]: "[[raw/Inbox/a]]" });
    const aligned = alignMoves(
      base,
      { ...base.files, [a]: "offline edit" },
      snapshot({ [c]: "original" }, [record(), record(2, b, c)]),
    );
    expect(aligned.baseFiles[c]).toBe("original");
    expect(aligned.files[c]).toBe("offline edit");
    expect(aligned.files[ref]).toBe("[[raw/Projects/c]]");
    expect(aligned.files[a]).toBeUndefined();
  });
  it("keeps offline edits when a known source directory moves remotely", () => {
    const from = "raw/Areas/健康/睡眠",
      to = "raw/Projects/减脂/睡眠",
      note = from + "/记录.md",
      base = snapshot({ [note]: "original", [ref]: "[[raw/Areas/健康/睡眠/记录]]" }),
      remoteFiles = moveNote(base.files, from, to).files;
    const aligned = alignMoves(
      base,
      { ...base.files, [note]: "offline edit" },
      snapshot(remoteFiles, [record(1, from, to)]),
    );
    expect(aligned.files[to + "/记录.md"]).toBe("offline edit");
    expect(aligned.files[ref]).toBe("[[raw/Projects/减脂/睡眠/记录]]");
  });
  it("preserves an offline deletion without resurrecting the old path", () => {
    const aligned = alignMoves(
      snapshot({ [a]: "original" }),
      {},
      snapshot({ [b]: "original" }, [record()]),
    );
    expect(aligned.baseFiles).toEqual({ [b]: "original" });
    expect(aligned.files).toEqual({});
  });
  it("moves newly created offline companions and attachment references consistently", () => {
    const asset = "raw/Inbox/a.assets/new.txt";
    const base = snapshot({ [a]: "[file](a.assets/new.txt)" });
    const aligned = alignMoves(
      base,
      { ...base.files, [asset]: "offline attachment" },
      snapshot({}, [record()]),
    );
    expect(aligned.files["raw/Areas/b.assets/new.txt"]).toBe(
      "offline attachment",
    );
    expect(aligned.files[b]).toBe("[file](b.assets/new.txt)");
    expect(aligned.baseFiles[b]).toBe(aligned.files[b]);
  });
  it("rewrites references to an attachment deleted offline", () => {
    const asset = "raw/Inbox/a.assets/old.txt",
      files = { [a]: "[file](a.assets/old.txt)", [asset]: "old" };
    const aligned = alignMoves(
      snapshot(files),
      { [a]: files[a] },
      snapshot({}, [record()]),
    );
    expect(aligned.files[b]).toBe("[file](b.assets/old.txt)");
    expect(aligned.files["raw/Areas/b.assets/old.txt"]).toBeUndefined();
  });
  it("refuses a local destination collision and missing movement history", () => {
    const base = snapshot({ [a]: "original" });
    expect(() =>
      alignMoves(
        base,
        { [a]: "edited", [b]: "different local note" },
        snapshot({}, [record()]),
      ),
    ).toThrow("不能覆盖");
    expect(() =>
      alignMoves(snapshot({ [b]: "original" }, [record()]), {}, snapshot({})),
    ).toThrow("记录缺失");
  });
  it("refuses ambiguous same-name creation without a baseline", () => {
    expect(() =>
      alignMoves(null, { [a]: "new unrelated note" }, snapshot({}, [record()])),
    ).toThrow("无法确认归属");
    expect(() =>
      alignMoves(
        snapshot({}),
        { [a]: "new unrelated note" },
        snapshot({}, [record()]),
      ),
    ).toThrow("无法确认归属");
  });
  it("rejects case-only renames and directory spelling aliases", () => {
    expect(() => moveNote({ [a]: "keep" }, a, "raw/Inbox/A.md")).toThrow(
      "大小写",
    );
    expect(() =>
      validateFiles({
        "raw/Areas/Folder/a.md": "a",
        "raw/Areas/folder/b.md": "b",
      }),
    ).toThrow("目录");
  });
  it("does not redirect a reused path after its movement has already been observed", () => {
    const base = snapshot({ [b]: "old note" }, [record()]);
    const aligned = alignMoves(
      base,
      { ...base.files, [a]: "new note at old name" },
      snapshot(base.files, [record()]),
    );
    expect(aligned.files[a]).toBe("new note at old name");
    expect(aligned.files[b]).toBe("old note");
  });
  it("rewrites OPML bodies, URL attributes and paired YAML filenames", () => {
    const opml = "raw/Inbox/a.opml",
      yaml = "raw/Inbox/a.relations.yaml";
    const original = serializeOpml({
      title: "A",
      root: {
        ...topic("Root"),
        body: "[[raw/Inbox/a]]",
        attrs: { url: "./a.md#标题", custom: "keep" },
      },
    });
    const moved = moveNote(
      { [a]: "# A", [opml]: original, [yaml]: serializeRelations(opml, []) },
      a,
      b,
    ).files;
    const map = parseOpml(moved["raw/Areas/b.opml"]);
    expect(map.root.body).toBe("[[raw/Areas/b]]");
    expect(map.root.attrs.url).toBe("b.md#标题");
    expect(map.root.attrs.custom).toBe("keep");
    expect(moved["raw/Areas/b.relations.yaml"]).toContain("map: ./b.opml");
    expect(() => validateFiles(moved)).not.toThrow();
  });
});

describe("movement journal and client integration", () => {
  it("commits a directory move as one recoverable server transaction", async () => {
    const { store, base } = await fixture();
    const seeded = await store.commit({
      requestId: "seed-directory-move",
      expectedRevision: base.revision,
      files: {
        ...base.files,
        "raw/Areas/健康/睡眠/记录.md": "[[raw/Areas/健康/睡眠/结论]]",
        "raw/Areas/健康/睡眠/结论.md": "结论",
        [ref]: "[[raw/Areas/健康/睡眠/记录]]",
      },
    });
    const moved = await store.move({
      requestId: "directory-move-integration",
      expectedRevision: seeded.revision,
      from: "raw/Areas/健康/睡眠",
      to: "raw/Projects/减脂/睡眠",
    });
    expect(moved.files["raw/Areas/健康/睡眠/记录.md"]).toBeUndefined();
    expect(moved.files["raw/Projects/减脂/睡眠/记录.md"]).toBe(
      "[[raw/Projects/减脂/睡眠/结论]]",
    );
    expect(moved.files[ref]).toBe("[[raw/Projects/减脂/睡眠/记录]]");
    expect(moved.moves?.[0]).toMatchObject({
      from: "raw/Areas/健康/睡眠",
      to: "raw/Projects/减脂/睡眠",
    });
  });
  it("keeps offline edits at the new path and merges independent remote edits", async () => {
    const { store, db, base } = await fixture();
    const row = await db.read();
    await db.update(row.version, (r) => ({
      ...r,
      files: { ...r.files, [a]: "LOCAL top\n\ngap\n\nbottom" },
    }));
    const moved = await store.move({
      requestId: "move-integration",
      expectedRevision: base.revision,
      from: a,
      to: b,
    });
    await store.commit({
      requestId: "remote-edit",
      expectedRevision: moved.revision,
      moveSequence: 1,
      files: { ...moved.files, [b]: "top\n\ngap\n\nREMOTE bottom" },
    });
    const synced = await synchronize(db);
    expect(synced.conflict).toBeNull();
    expect(synced.files[b]).toBe("LOCAL top\n\ngap\n\nREMOTE bottom");
    expect(synced.files[a]).toBeUndefined();
    expect((await store.snapshot()).files[ref]).toBe(
      "[[raw/Areas/b#标题|引用]]",
    );
    expect(await fs.readFile(path.join(store.root, b), "utf8")).toBe(
      synced.files[b],
    );
  });
  it("handles a movement that races the outgoing commit", async () => {
    const { store, db, base, api } = await fixture();
    const row = await db.read();
    await db.update(row.version, (r) => ({
      ...r,
      files: { ...r.files, [a]: "offline" },
    }));
    let first = true;
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (url === "/api/commit" && first) {
        first = false;
        await store.move({
          requestId: "race-move",
          expectedRevision: base.revision,
          from: a,
          to: b,
        });
      }
      return api(url, init);
    });
    const waiting = await synchronize(db);
    expect(waiting.pending).toBeNull();
    expect(waiting.conflict?.items).toEqual([]);
    await resolveConflicts(db, waiting, {});
    const synced = await synchronize(db);
    expect(synced.files[b]).toBe("offline");
    expect((await store.snapshot()).files[a]).toBeUndefined();
  });
  it("retries a lost receipt from before a movement without dropping newer offline edits", async () => {
    const { store, db, api } = await fixture();
    let lost = false;
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      const response = await api(url, init);
      if (url === "/api/commit" && !lost) {
        lost = true;
        throw new Error("lost response");
      }
      return response;
    });
    await expect(synchronize(db)).rejects.toThrow("lost response");
    const current = await store.snapshot();
    await store.move({
      requestId: "move-after-lost-ack",
      expectedRevision: current.revision,
      from: a,
      to: b,
    });
    const row = await db.read();
    await db.update(row.version, (r) => ({
      ...r,
      files: { ...r.files, [a]: "newer offline draft" },
    }));
    const acknowledged = await synchronize(db);
    expect(acknowledged.files[a]).toBe("newer offline draft");
    expect(hasUnsyncedChanges(acknowledged)).toBe(true);
    const synced = await synchronize(db);
    expect(synced.files[b]).toBe("newer offline draft");
    expect(synced.files[a]).toBeUndefined();
    expect(hasUnsyncedChanges(synced)).toBe(false);
  });
  it("refuses an existing on-disk directory alias before starting a transaction", async () => {
    const { store, base } = await fixture();
    const nested = await store.commit({
      requestId: "nested-dir",
      expectedRevision: base.revision,
      files: { ...base.files, "raw/Areas/Folder/a.md": "keep" },
    });
    await expect(
      store.commit({
        requestId: "alias-dir",
        expectedRevision: nested.revision,
        files: { [a]: "unrelated", "raw/Areas/folder/b.md": "new" },
      }),
    ).rejects.toThrow("拼写不同");
    expect(await store.snapshot()).toEqual(nested);
  });
  it("rejects unacknowledged movement even with the current content revision", async () => {
    const { store, base } = await fixture();
    const moved = await store.move({
      requestId: "guard-move",
      expectedRevision: base.revision,
      from: a,
      to: b,
    });
    await expect(
      store.commit({
        requestId: "old-client-request",
        expectedRevision: moved.revision,
        files: base.files,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await store.snapshot()).toEqual(moved);
  });
  it("persists chained moves through restart, deduplicates retries and changes revision on move-back", async () => {
    const { store, base } = await fixture();
    const request = {
      requestId: "persist-move",
      expectedRevision: base.revision,
      from: a,
      to: b,
    };
    const moved = await store.move(request);
    const restarted = new FileStore(store.root);
    await restarted.init(false);
    expect(await restarted.move(request)).toEqual(moved);
    const back = await restarted.move({
      requestId: "move-back",
      expectedRevision: moved.revision,
      from: b,
      to: a,
    });
    expect(back.files).toEqual(base.files);
    expect(back.revision).not.toBe(base.revision);
    expect(back.moves).toHaveLength(2);
    const text = await fs.readFile(
      path.join(store.root, "state/moves.json"),
      "utf8",
    );
    expect(text).toContain(a);
    expect(text).toContain(b);
  });
  it.each(["prepared", "files", "ledger", "moves", "committed"] as const)(
    "recovers files, movement log and receipt after interruption at %s",
    async (point) => {
      const { store, base } = await fixture();
      const failing = new FileStore(store.root, point);
      await failing.init(false);
      const request = {
        requestId: "interrupted-move",
        expectedRevision: base.revision,
        from: a,
        to: b,
      };
      await expect(failing.move(request)).rejects.toThrow("INJECTED_CRASH");
      const restarted = new FileStore(store.root);
      await restarted.init(false);
      const recovered = await restarted.snapshot();
      if (point === "committed") {
        expect(recovered.files[a]).toBeUndefined();
        expect(recovered.moves).toHaveLength(1);
        expect(await restarted.move(request)).toEqual(recovered);
      } else {
        expect(recovered).toEqual(base);
        expect((await restarted.move(request)).moves).toHaveLength(1);
      }
    },
  );
});
