import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore } from "../server/store";
import { ledgerSchema } from "../server/journal";

const note = "raw/Inbox/a.md";
async function fixture() {
  const base = path.resolve(".prototype-data/tests");
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "metadata-"));
  const store = new FileStore(path.join(root, "library"));
  await store.init(false);
  const outside = path.join(root, "other-file.json");
  await fs.writeFile(outside, "KEEP OUTSIDE CONTENT");
  return { root, store, outside };
}
describe("portable snapshot validation and metadata boundaries", () => {
  it("validates the stored file order instead of imposing this machine's collation", () => {
    const names = ["raw/Inbox/z.md", "raw/Inbox/ä.md", "raw/Inbox/知识.md"];
    const files = Object.fromEntries(
      names.sort((a, b) => b.localeCompare(a)).map((name) => [name, name]),
    );
    const revision = createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex");
    const ledger = {
      receipt: { fingerprint: "original", result: { revision, files } },
    };
    expect(JSON.stringify(ledgerSchema.parse(ledger))).toBe(
      JSON.stringify(ledger),
    );
    expect(() =>
      ledgerSchema.parse({
        receipt: {
          fingerprint: "original",
          result: { revision, files: { ...files, [note]: "tampered" } },
        },
      }),
    ).toThrow("快照校验值");
  });
  it.each(["constructor", "toString", "__proto__"])(
    "uses an own receipt entry for request key %s",
    async (requestId) => {
      const { store } = await fixture();
      const change = {
        requestId,
        expectedRevision: (await store.snapshot()).revision,
        files: { [note]: "first" },
      };
      const result = await store.commit(change);
      expect(await store.commit(change)).toEqual(result);
    },
  );
  it("validates special-key receipt contents rather than silently dropping them", () => {
    expect(() =>
      ledgerSchema.parse(JSON.parse('{"__proto__":{"bad":true}}')),
    ).toThrow();
    expect(Object.hasOwn(Object.prototype, "bad")).toBe(false);
  });
  it("retries a movement whose request key matches an Object prototype name", async () => {
    const { store } = await fixture();
    const before = await store.commit({
      requestId: "normal-seed",
      expectedRevision: (await store.snapshot()).revision,
      files: { [note]: "move" },
    });
    const request = {
      requestId: "constructor",
      expectedRevision: before.revision,
      from: note,
      to: "raw/Projects/a.md",
    };
    const after = await store.move(request);
    expect(await store.move(request)).toEqual(after);
  });
  it("refuses a linked ancestor even when the final directory has a valid marker", async () => {
    const { root, store } = await fixture();
    await fs.symlink(root, path.join(root, "alias"), "junction");
    await expect(
      new FileStore(path.join(root, "alias/library")).init(false),
    ).rejects.toThrow("符号链接");
    expect((await store.snapshot()).files).toEqual({});
  });
  it.each(["journal.json", "ledger.json", "moves.json"])(
    "refuses hardlinked state file %s without modifying its other name",
    async (name) => {
      const { store, outside } = await fixture();
      await fs.link(outside, path.join(store.root, "state", name));
      await expect(new FileStore(store.root).init(false)).rejects.toThrow(
        "硬链接",
      );
      expect(await fs.readFile(outside, "utf8")).toBe("KEEP OUTSIDE CONTENT");
    },
  );
  it("refuses a hardlinked state temporary file before any document write", async () => {
    const { store, outside } = await fixture();
    const before = await store.snapshot();
    await fs.link(outside, path.join(store.root, "state/journal.json.tmp"));
    await expect(
      store.commit({
        requestId: "linked-state-temp",
        expectedRevision: before.revision,
        files: { [note]: "new" },
      }),
    ).rejects.toThrow("硬链接");
    expect(await fs.readFile(outside, "utf8")).toBe("KEEP OUTSIDE CONTENT");
    expect(await store.snapshot()).toEqual(before);
  });
  it("does not follow a hardlinked raw write temporary file, and retains the recovery scene", async () => {
    const { store, outside } = await fixture();
    const before = await store.snapshot();
    await fs.mkdir(path.join(store.root, "raw/Inbox"), { recursive: true });
    await fs.link(outside, path.join(store.root, note + ".risk-tmp"));
    await expect(
      store.commit({
        requestId: "linked-raw-temp",
        expectedRevision: before.revision,
        files: { [note]: "new" },
      }),
    ).rejects.toThrow("硬链接");
    expect(await fs.readFile(outside, "utf8")).toBe("KEEP OUTSIDE CONTENT");
    expect(await store.snapshot()).toEqual(before);
    expect(
      (await fs.lstat(path.join(store.root, note + ".risk-tmp"))).nlink,
    ).toBeGreaterThan(1);
  });
});
