import { describe, expect, it } from "vitest";
import {
  editMap,
  parseOpml,
  serializeOpml,
  setMapTitle,
  topic,
  type Mindmap,
} from "../src/core/formats";
import { moveNote } from "../src/core/paths";
import { validateFiles } from "../src/core/contracts";

const simple = serializeOpml({ title: "导图", root: topic("根") });
describe("loss-aware OPML metadata", () => {
  it("updates a readable map title without introducing an application identifier", () => {
    const source = serializeOpml({ title: "旧标题", root: topic("根") });
    expect(parseOpml(setMapTitle(source, "新标题"))).toMatchObject({
      title: "新标题",
      root: { text: "根" },
    });
    expect(() => setMapTitle(source, "")).toThrow("标题");
  });
  it("preserves standard scalar head metadata and custom scalar fields through edits", () => {
    const fields = {
      dateCreated: "Fri, 01 Jan 2021 00:00:00 GMT",
      dateModified: "Sat, 02 Jan 2021 00:00:00 GMT",
      ownerName: "示例作者",
      ownerEmail: "author@example.invalid",
      docs: "https://opml.org/spec2.opml",
      expansionState: "1,2",
      windowTop: "001",
      custom: "前后空白 \n& < > 😀",
    };
    const map: Mindmap = { title: "导图", root: topic("根"), head: fields };
    const parsed = parseOpml(serializeOpml(map));
    expect(parsed).toEqual(map);
    const edited = editMap(parsed, [], (next) => {
      next.root.text = "改名";
      next.root.children.push(topic("子节点"));
    }).map;
    expect(parseOpml(serializeOpml(edited)).head).toEqual(fields);
    expect(parsed.root.text).toBe("根");
  });
  it("preserves namespaced document/node attributes and scalar head elements", () => {
    const map: Mindmap = {
      title: "导图",
      attributes: {
        "xmlns:custom": "urn:example:custom",
        "custom:source": "001",
      },
      head: { "custom:description": "未解释的元信息" },
      root: {
        ...topic("根"),
        attrs: { "custom:color": "#123456", isComment: "true" },
      },
    };
    expect(parseOpml(serializeOpml(map))).toEqual(map);
    validateFiles({ "raw/Inbox/a.opml": serializeOpml(map) });
  });
  it("keeps prototype-named attributes as own data rather than altering object prototypes", () => {
    const attrs = JSON.parse(
      '{"__proto__":"keep","constructor":"ctor","prototype":"value"}',
    );
    const map: Mindmap = {
      title: "t",
      root: { ...topic("根"), attrs },
      attributes: attrs,
    };
    const result = parseOpml(serializeOpml(map));
    expect(Object.hasOwn(result.root.attrs, "__proto__")).toBe(true);
    expect(result.root.attrs).toEqual(attrs);
    expect(result.attributes).toEqual(attrs);
    expect(Object.getPrototypeOf(result.root.attrs)).toBe(Object.prototype);
  });
  it("either preserves a prototype-named head element or explicitly rejects it", () => {
    const xml = simple.replace(
      "</head>",
      "<__proto__>keep me</__proto__></head>",
    );
    try {
      const parsed = parseOpml(xml);
      expect(Object.hasOwn(parsed.head ?? {}, "__proto__")).toBe(true);
      expect(parsed.head?.["__proto__"]).toBe("keep me");
    } catch (error) {
      // An explicit parser error is acceptable; silently losing the field is not.
      if (String(error).includes("AssertionError")) throw error;
      expect(error).toBeInstanceOf(Error);
    }
  });
  it.each([
    "<custom><nested>keep</nested></custom>",
    '<custom kind="x">keep</custom>',
    "<custom>one</custom><custom>two</custom>",
    "<title>duplicate</title>",
    "<?custom preserve='yes'?>",
  ])(
    "rejects unsupported head structure without modifying input: %s",
    (extra) => {
      const source = simple.replace("</head>", extra + "</head>");
      expect(() => parseOpml(source)).toThrow();
      expect(source).toContain(extra);
    },
  );
  it("preserves metadata during a reference-rewriting bundle move", () => {
    const map: Mindmap = {
      title: "t",
      head: {
        ownerName: "作者",
        ownerEmail: "author@example.invalid",
        docs: "https://opml.org/spec2.opml",
      },
      attributes: { custom: "opaque" },
      root: { ...topic("根"), body: "[[raw/Inbox/a.md]]" },
    };
    const files = {
      "raw/Inbox/a.md": "# A",
      "raw/Inbox/a.opml": serializeOpml(map),
    };
    const result = moveNote(files, "raw/Inbox/a.md", "raw/Areas/b.md");
    const moved = parseOpml(result.files["raw/Areas/b.opml"]);
    expect(moved.head).toEqual(map.head);
    expect(moved.attributes).toEqual(map.attributes);
    expect(moved.root.body).toBe("[[raw/Areas/b.md]]");
  });
  it.each(["head", "attributes"] as const)(
    "stops moves if unknown %s fields contain affected references",
    (field) => {
      const map: Mindmap = {
        title: "t",
        root: topic("根"),
        [field]: { custom: "raw/Inbox/a.md" },
      };
      const files = Object.freeze({
        "raw/Inbox/a.md": "# A",
        "raw/Inbox/a.opml": serializeOpml(map),
      });
      const original = JSON.stringify(files);
      expect(() => moveNote(files, "raw/Inbox/a.md", "raw/Areas/b.md")).toThrow(
        "未知结构化字段",
      );
      expect(JSON.stringify(files)).toBe(original);
    },
  );
  it("rewrites known head URL fields while retaining literal metadata", () => {
    const map: Mindmap = {
      title: "t",
      root: topic("根"),
      head: {
        docs: "raw/Inbox/a.md",
        ownerId: "./a.md",
        ownerName: "literal.md",
        ownerEmail: "author@example.invalid",
      },
    };
    const moved = moveNote(
      { "raw/Inbox/a.md": "# A", "raw/Inbox/a.opml": serializeOpml(map) },
      "raw/Inbox/a.md",
      "raw/Areas/b.md",
    );
    expect(parseOpml(moved.files["raw/Areas/b.opml"]).head).toEqual({
      docs: "raw/Areas/b.md",
      ownerId: "b.md",
      ownerName: "literal.md",
      ownerEmail: "author@example.invalid",
    });
  });
  it("rejects metadata that would overwrite native fields or inject markup", () => {
    for (const head of [
      { title: "wrong" },
      { "bad><script": "wrong" },
    ] as Record<string, string>[])
      expect(() =>
        serializeOpml({ title: "t", root: topic("根"), head }),
      ).toThrow();
    expect(() =>
      serializeOpml({
        title: "t",
        root: topic("根"),
        attributes: { version: "99" },
      }),
    ).toThrow();
    const xml = serializeOpml({
      title: "t",
      root: topic("根"),
      head: { custom: '<script a="b">&</script>' },
    });
    expect(xml).not.toContain("<script");
    expect(parseOpml(xml).head?.custom).toBe('<script a="b">&</script>');
  });
  it.each([
    'version="1.1" encoding="UTF-8"',
    'version="1.0" encoding="UTF-16"',
    'version="1.0" encoding="UTF-8" standalone="yes"',
  ])("refuses declarations it cannot roundtrip: %s", (declaration) => {
    expect(() =>
      parseOpml(simple.replace(/<\?xml[^?]+\?>/, `<?xml ${declaration}?>`)),
    ).toThrow("XML 声明");
  });
});
