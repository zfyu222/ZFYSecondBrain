import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FileStore, ConflictError } from "../server/store";

const p = "raw/Inbox/a.md",
  q = "raw/Areas/b.md";
async function fixture(failAfter?: number) {
  const base = path.resolve(".prototype-data/tests");
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "store-"));
  const store = new FileStore(root, failAfter);
  await store.init(false);
  return store;
}
describe("journaled text storage", () => {
  it("writes real UTF-8 files, retries idempotently, and rejects stale revisions", async () => {
    const store = await fixture(),
      before = await store.snapshot();
    const request = {
      requestId: "request-0001",
      expectedRevision: before.revision,
      files: { [p]: "# 中文\r\n😀" },
    };
    const result = await store.commit(request);
    expect(await fs.readFile(path.join(store.root, p), "utf8")).toBe(
      request.files[p],
    );
    expect(await store.commit(request)).toEqual(result);
    await expect(
      store.commit({ ...request, files: { [p]: "different" } }),
    ).rejects.toThrow("幂等");
    await expect(
      store.commit({ ...request, requestId: "request-0002" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await store.snapshot()).toEqual(result);
  });
  it("serializes concurrent writers, so only one common-baseline commit succeeds", async () => {
    const store = await fixture(),
      base = await store.snapshot();
    const results = await Promise.allSettled(
      ["A", "B"].map((value) =>
        store.commit({
          requestId: "concurrent-" + value,
          expectedRevision: base.revision,
          files: { [p]: value },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it.each([1, 2, 3])(
    "rolls back a prepared transaction interrupted after write %i",
    async (step) => {
      const seed = await fixture();
      const before = await seed.commit({
        requestId: "before-crash",
        expectedRevision: (await seed.snapshot()).revision,
        files: { [p]: "before", [q]: "delete later" },
      });
      const failing = new FileStore(seed.root, step);
      await failing.init(false);
      await expect(
        failing.commit({
          requestId: "crash-request",
          expectedRevision: before.revision,
          files: { [p]: "after", "raw/Projects/new.md": "new" },
        }),
      ).rejects.toThrow("INJECTED_CRASH");
      const restarted = new FileStore(seed.root);
      await restarted.init(false);
      expect(await restarted.snapshot()).toEqual(before);
    },
  );
  it("does not expose partial files on a read after a write error", async () => {
    const store = await fixture(1),
      before = await store.snapshot();
    await expect(
      store.commit({
        requestId: "crash-read-1",
        expectedRevision: before.revision,
        files: { [p]: "partial", [q]: "partial" },
      }),
    ).rejects.toThrow();
    expect(await store.snapshot()).toEqual(before);
  });
  it("refuses rollback when an external editor changed the recovery scene", async () => {
    const store = await fixture(1),
      before = await store.snapshot();
    await expect(
      store.commit({
        requestId: "crash-external",
        expectedRevision: before.revision,
        files: { [p]: "partial" },
      }),
    ).rejects.toThrow();
    await fs.writeFile(path.join(store.root, p), "external");
    await expect(new FileStore(store.root).init(false)).rejects.toThrow(
      "外部修改",
    );
    expect(await fs.readFile(path.join(store.root, p), "utf8")).toBe(
      "external",
    );
  });
  it("moves references transactionally and retries a lost move response", async () => {
    const store = await fixture();
    const before = await store.commit({
      requestId: "move-seed",
      expectedRevision: (await store.snapshot()).revision,
      files: { [p]: "# A", [q]: "[[raw/Inbox/a]]" },
    });
    const request = {
      requestId: "move-request",
      expectedRevision: before.revision,
      from: p,
      to: "raw/Projects/a.md",
    };
    const result = await store.move(request);
    expect(result.files[q]).toBe("[[raw/Projects/a]]");
    expect(await store.move(request)).toEqual(result);
  });
  it("rejects invalid payload before touching files", async () => {
    const store = await fixture(),
      before = await store.snapshot();
    await expect(
      store.commit({
        requestId: "bad-structure",
        expectedRevision: before.revision,
        files: { "raw/Inbox/a.opml": "<bad/>" },
      }),
    ).rejects.toThrow();
    expect(await store.snapshot()).toEqual(before);
  });
  it("does not claim an existing nonempty user directory", async () => {
    const base = path.resolve(".prototype-data/tests");
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, "untouched-"));
    await fs.writeFile(path.join(root, "user.txt"), "keep");
    await expect(new FileStore(root).init()).rejects.toThrow("非空");
  });
});
