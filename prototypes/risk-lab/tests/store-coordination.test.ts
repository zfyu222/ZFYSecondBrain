import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileStore, ConflictError, RejectedError } from "../server/store";

const note = "raw/Inbox/a.md";
async function root() {
  const parent = path.resolve(".prototype-data/tests");
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, "coordination-"));
}
async function fixture() {
  const store = new FileStore(await root());
  await store.init(false);
  const before = await store.commit({
    requestId: "initial-document",
    expectedRevision: (await store.snapshot()).revision,
    files: { [note]: "before" },
  });
  return { store, before, second: new FileStore(store.root) };
}
afterEach(() => vi.restoreAllMocks());
describe("same-directory store coordination", () => {
  it("serializes initialization of multiple instances in the same empty directory", async () => {
    const directory = await root(),
      first = new FileStore(directory),
      second = new FileStore(path.join(directory, "."));
    await Promise.all([first.init(false), second.init(false)]);
    expect(await first.snapshot()).toEqual(await second.snapshot());
  });
  it("allows exactly one concurrent writer with the same baseline across instances", async () => {
    const { store, second, before } = await fixture();
    await second.init(false);
    const results = await Promise.allSettled(
      [store, second].map((instance, i) =>
        instance.commit({
          requestId: "parallel-write-" + i,
          expectedRevision: before.revision,
          files: { [note]: "writer-" + i },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ConflictError,
    );
    expect(await store.snapshot()).toEqual(await second.snapshot());
  });
  it("initializes shared seed content only once without nested-queue deadlock", async () => {
    const directory = await root(),
      first = new FileStore(directory),
      second = new FileStore(directory);
    await Promise.all([first.init(), second.init()]);
    expect(await first.snapshot()).toEqual(await second.snapshot());
    const ledger = JSON.parse(
      await fs.readFile(path.join(directory, "state/ledger.json"), "utf8"),
    );
    expect(Object.keys(ledger)).toEqual(["initial-seed-v1"]);
  });
  it("coordinates Windows case aliases and normalized relative path components", async () => {
    const { store, before } = await fixture();
    const alias =
      process.platform === "win32"
        ? store.root.toUpperCase()
        : store.root + "/../" + path.basename(store.root);
    const second = new FileStore(alias);
    await second.init(false);
    const results = await Promise.allSettled(
      [store, second].map((instance, index) =>
        instance.commit({
          requestId: "aliased-writer-" + index,
          expectedRevision: before.revision,
          files: { [note]: String(index) },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ConflictError,
    );
  });
  it("does not let public recovery roll back another instance's active transaction", async () => {
    const { store, second, before } = await fixture();
    await second.init(false);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(from) === path.join(store.root, note + ".risk-tmp")) {
        entered();
        await gate;
      }
    });
    const committing = store.commit({
      requestId: "active-transaction",
      expectedRevision: before.revision,
      files: { [note]: "after" },
    });
    try {
      await Promise.race([
        ready,
        committing.then(() => {
          throw new Error(
            "Expected the transaction to reach the guarded file write",
          );
        }),
      ]);
      const recovering = second.recover();
      release();
      const [committed] = await Promise.all([committing, recovering]);
      expect(await second.snapshot()).toEqual(committed);
      expect((await store.snapshot()).files[note]).toBe("after");
    } finally {
      release();
      await committing.catch(() => {});
    }
  });
  it("lets another instance recover a failed writer before exposing a snapshot", async () => {
    const { store, second, before } = await fixture();
    const failing = new FileStore(store.root, "files");
    await failing.init(false);
    await expect(
      failing.commit({
        requestId: "failed-writer",
        expectedRevision: before.revision,
        files: { [note]: "partial" },
      }),
    ).rejects.toThrow("INJECTED_CRASH");
    expect(await second.snapshot()).toEqual(before);
    expect(await store.snapshot()).toEqual(before);
  });
  it("does not poison the directory queue after a rejected request", async () => {
    const { store, second, before } = await fixture();
    await expect(
      store.commit({
        requestId: "rejected-writer",
        expectedRevision: before.revision,
        files: { "../escape.md": "no" },
      }),
    ).rejects.toThrow();
    const next = await second.commit({
      requestId: "valid-after-error",
      expectedRevision: before.revision,
      files: { [note]: "valid" },
    });
    expect((await store.snapshot()).revision).toBe(next.revision);
  });
  it("rejects existing directory destinations before preparing any journal", async () => {
    const { store, before } = await fixture();
    await fs.mkdir(path.join(store.root, "raw/Inbox/occupied.md"));
    await expect(
      store.commit({
        requestId: "directory-collision",
        expectedRevision: before.revision,
        files: { [note]: "should not change", "raw/Inbox/occupied.md": "no" },
      }),
    ).rejects.toBeInstanceOf(RejectedError);
    await expect(
      fs.stat(path.join(store.root, "state/journal.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.snapshot()).toEqual(before);
  });
});
