import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore } from "../server/store";
import { restorePrototype } from "../server/restore";
import { inspectMarkdown } from "../src/core/preview";
import { serializeOpml, serializeRelations, topic } from "../src/core/formats";

const note = "raw/Inbox/a.md";
const text = "\uFEFF---\r\ntitle: 文件标记\r\n---\r\n# 标题\r\n\r\n中文 😀\r\n";
async function fixture() {
  const parent = path.resolve(".prototype-data/tests");
  await fs.mkdir(parent, { recursive: true });
  const store = new FileStore(
    await fs.mkdtemp(path.join(parent, "text-bytes-")),
  );
  await store.init(false);
  return store;
}
describe("original UTF-8 byte preservation", () => {
  it("commits BOM-prefixed Markdown without producing an unrecoverable journal", async () => {
    const store = await fixture();
    const after = await store.commit({
      requestId: "bom-document",
      expectedRevision: (await store.snapshot()).revision,
      files: { [note]: text },
    });
    expect(after.files[note]).toBe(text);
    expect(await store.snapshot()).toEqual(after);
    expect(await fs.readFile(path.join(store.root, note))).toEqual(
      Buffer.from(text, "utf8"),
    );
    const reopened = new FileStore(store.root);
    await reopened.init(false);
    expect((await reopened.snapshot()).files[note]).toBe(text);
  });
  it("retains BOM and CRLF in external files through reading, editing and moving", async () => {
    const store = await fixture();
    await fs.mkdir(path.join(store.root, "raw/Inbox"), { recursive: true });
    await fs.writeFile(path.join(store.root, note), Buffer.from(text));
    const before = await store.snapshot();
    expect(before.files[note]).toBe(text);
    const changed = text.replace("中文", "修改中文");
    const after = await store.commit({
      requestId: "edit-bom",
      expectedRevision: before.revision,
      files: { [note]: changed },
    });
    const moved = await store.move({
      requestId: "move-bom",
      expectedRevision: after.revision,
      from: note,
      to: "raw/Areas/b.md",
    });
    expect(moved.files["raw/Areas/b.md"]).toBe(changed);
    expect(await fs.readFile(path.join(store.root, "raw/Areas/b.md"))).toEqual(
      Buffer.from(changed),
    );
  });
  it.each(["minimal", "standard", "full"] as const)(
    "preserves source bytes during %s backup restoration",
    async (tier) => {
      const store = await fixture();
      await store.commit({
        requestId: "restore-bom",
        expectedRevision: (await store.snapshot()).revision,
        files: { [note]: text },
      });
      const target = store.root + "-restore";
      await restorePrototype(store.root, target, tier);
      expect(await fs.readFile(path.join(target, note))).toEqual(
        Buffer.from(text),
      );
      expect((await new FileStore(target).snapshot()).files[note]).toBe(text);
    },
  );
  it("keeps frontmatter and heading inspection correct without normalizing the source", () => {
    const inspected = inspectMarkdown(text);
    expect(inspected.metadata).toEqual({ title: "文件标记" });
    expect(inspected.headings[0].title).toBe("标题");
  });
  it("still rejects invalid UTF-8 instead of replacing or guessing bytes", async () => {
    const store = await fixture();
    await fs.mkdir(path.join(store.root, "raw/Inbox"), { recursive: true });
    const bytes = Buffer.from([0xc3, 0x28]);
    await fs.writeFile(path.join(store.root, note), bytes);
    await expect(store.snapshot()).rejects.toThrow();
    expect(await fs.readFile(path.join(store.root, note))).toEqual(bytes);
  });
  it("rolls back an interrupted BOM edit without treating the marker as external damage", async () => {
    const store = await fixture();
    const before = await store.commit({
      requestId: "bom-before-crash",
      expectedRevision: (await store.snapshot()).revision,
      files: { [note]: text },
    });
    const crashing = new FileStore(store.root, 1);
    await expect(
      crashing.commit({
        requestId: "bom-after-crash",
        expectedRevision: before.revision,
        files: { [note]: text + "追加\r\n" },
      }),
    ).rejects.toThrow("INJECTED_CRASH");
    const reopened = new FileStore(store.root);
    await reopened.init(false);
    expect(await reopened.snapshot()).toEqual(before);
    expect(await fs.readFile(path.join(store.root, note))).toEqual(
      Buffer.from(text),
    );
  });
  it("preserves an embedded marker instead of normalizing text", async () => {
    const store = await fixture();
    const content = text + "内容\uFEFF内容\n";
    const after = await store.commit({
      requestId: "embedded-marker",
      expectedRevision: (await store.snapshot()).revision,
      files: { [note]: content },
    });
    expect(after.files[note]).toBe(content);
    expect(await fs.readFile(path.join(store.root, note))).toEqual(
      Buffer.from(content),
    );
  });
  it("accepts and retains standard BOM-prefixed OPML and relation YAML", async () => {
    const store = await fixture();
    const opml = "raw/Inbox/map.opml";
    const yaml = "raw/Inbox/map.relations.yaml";
    const map = { title: "导图", root: topic("根") };
    const files = {
      [opml]: "\uFEFF" + serializeOpml(map).replaceAll("\n", "\r\n"),
      [yaml]: "\uFEFF" + serializeRelations(opml, []).replaceAll("\n", "\r\n"),
    };
    const after = await store.commit({
      requestId: "bom-map-and-relations",
      expectedRevision: (await store.snapshot()).revision,
      files,
    });
    expect(after.files).toEqual(files);
    expect(await fs.readFile(path.join(store.root, opml))).toEqual(
      Buffer.from(files[opml]),
    );
    expect(await fs.readFile(path.join(store.root, yaml))).toEqual(
      Buffer.from(files[yaml]),
    );
  });
});
