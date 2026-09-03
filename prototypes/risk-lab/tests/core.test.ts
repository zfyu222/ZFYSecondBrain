import { describe, expect, it } from "vitest";
import {
  editMap,
  flatten,
  parseOpml,
  parseRelations,
  safeYaml,
  serializeOpml,
  serializeRelations,
  topic,
  type Relation,
} from "../src/core/formats";
import { validateFiles, pathSchema } from "../src/core/contracts";
import { mergeFiles } from "../src/core/merge";
import { moveNote, rewriteMarkdown } from "../src/core/paths";

const p = "raw/Inbox/a.md";
describe("open formats", () => {
  it("round-trips Chinese, escaped characters, multiline bodies and unknown attributes", () => {
    const map = {
      title: "知识 & <关系>",
      root: {
        ...topic("根/节点[1]"),
        body: '行一\r\n\t"quote" & <标签> 😀',
        attrs: { custom: "001", url: "./a.md#标题" },
        children: [topic("子节点")],
      },
    };
    expect(parseOpml(serializeOpml(map))).toEqual(map);
  });
  it.each([100, 500])(
    "round-trips %i topics without losing their order",
    (count) => {
      const map = {
        title: "规模",
        root: {
          ...topic("根"),
          children: Array.from({ length: count }, (_, i) => topic("节点" + i)),
        },
      };
      expect(parseOpml(serializeOpml(map))).toEqual(map);
    },
  );
  it("renames/reorders duplicate topics and remaps only surviving relations", () => {
    const map = {
      title: "t",
      root: { ...topic("根"), children: [topic("同名"), topic("同名")] },
    };
    const rows = flatten(map);
    const relations: Relation[] = [
      {
        from: rows[1].path,
        to: rows[2].path,
        type: "相关",
        status: "confirmed",
      },
    ];
    const changed = editMap(map, relations, (m) => {
      m.root.children.reverse();
      m.root.children[1].text = "新名字";
    });
    expect(changed.relations[0]).toMatchObject({
      from: "/根[1]/新名字[1]",
      to: "/根[1]/同名[1]",
    });
    expect(
      parseRelations(
        serializeRelations("a.opml", changed.relations),
        changed.map,
      ),
    ).toEqual(changed.relations);
    expect(
      editMap(changed.map, changed.relations, (m) => {
        m.root.children.pop();
      }).relations,
    ).toEqual([]);
  });
  it("rejects unknown elements, DTDs and mixed text rather than discarding them", () => {
    const xml = serializeOpml({ title: "t", root: topic("根") });
    expect(() => parseOpml("<!DOCTYPE opml>" + xml)).toThrow();
    expect(() =>
      parseOpml(
        xml.replace("</head>", "<custom><nested>keep</nested></custom></head>"),
      ),
    ).toThrow();
    expect(() => parseOpml(xml.replace("<body>", "<body>keep me"))).toThrow();
    expect(() =>
      parseOpml(xml.replace("</opml>", "</opml><extra/>")),
    ).toThrow();
  });
  it("rejects YAML duplicate keys, aliases and dangling relation endpoints", () => {
    expect(() => safeYaml("a: 1\na: 2")).toThrow();
    expect(() => safeYaml("a: &x [1]\nb: *x")).toThrow();
    expect(() =>
      parseRelations(
        serializeRelations("a.opml", [
          {
            from: "/missing",
            to: "/missing",
            type: "相关",
            status: "confirmed",
          },
        ]),
        { title: "t", root: topic("根") },
      ),
    ).toThrow();
  });
  it.each([
    "../a.md",
    "raw/Inbox/../a.md",
    "raw/Inbox/CON.md",
    "raw/Inbox/a.md ",
    "raw/Inbox/a.risk-tmp",
    "raw/Inbox/a\\b.md",
  ])("rejects unsafe path %s", (path) =>
    expect(pathSchema.safeParse(path).success).toBe(false),
  );
  it("rejects case collisions and file/directory collisions", () => {
    expect(() => validateFiles({ [p]: "", "raw/Inbox/A.md": "" })).toThrow();
    expect(() => validateFiles({ [p]: "", [p + "/b.md"]: "" })).toThrow();
  });
});
describe("three-way merge", () => {
  it("preserves independent changes and exact newline shape", () => {
    expect(
      mergeFiles(
        { [p]: "a\n\nb\n\nc" },
        { [p]: "A\n\nb\n\nc" },
        { [p]: "a\n\nb\n\nC" },
      ),
    ).toEqual({ files: { [p]: "A\n\nb\n\nC" }, conflicts: [] });
  });
  it("does not choose silently for overlapping edits or missing baselines", () => {
    expect(
      mergeFiles({ [p]: "a" }, { [p]: "b" }, { [p]: "c" }).conflicts,
    ).toHaveLength(1);
    expect(mergeFiles({}, { [p]: "b" }, { [p]: "c" }).conflicts).toHaveLength(
      1,
    );
  });
  it("handles deletion versus unchanged and deletion versus edit", () => {
    expect(mergeFiles({ [p]: "a" }, {}, { [p]: "a" })).toEqual({
      files: {},
      conflicts: [],
    });
    expect(
      mergeFiles({ [p]: "a" }, {}, { [p]: "b" }).conflicts[0].local,
    ).toBeNull();
  });
  it("never line-merges structured graphs", () => {
    expect(
      mergeFiles({ "a.opml": "a" }, { "a.opml": "b" }, { "a.opml": "c" })
        .conflicts,
    ).toHaveLength(1);
  });
});
describe("portable path updates", () => {
  it("rewrites links, embeds and definitions, but leaves code and prose intact", () => {
    const md =
      "[read](../Inbox/a.md#标题)\n[[raw/Inbox/a#标题|名称]]\n![[raw/Inbox/a]]\n[x][ref]\n\n[ref]: ../Inbox/a.md\n\n`[[raw/Inbox/a]]`\n\n```md\n[keep](../Inbox/a.md)\n```\nraw/Inbox/a.md";
    const moved = moveNote(
      { [p]: "# a", "raw/Areas/ref.md": md },
      p,
      "raw/Projects/a.md",
    );
    expect(moved.files["raw/Areas/ref.md"]).toBe(
      md
        .replace("[read](../Inbox/a.md#标题)", "[read](../Projects/a.md#标题)")
        .replace("[[raw/Inbox/a#标题|名称]]", "[[raw/Projects/a#标题|名称]]")
        .replace("![[raw/Inbox/a]]", "![[raw/Projects/a]]")
        .replace("[ref]: ../Inbox/a.md", "[ref]: ../Projects/a.md"),
    );
    expect(moved.files[p]).toBeUndefined();
  });
  it("adjusts the moved owner’s relative references, including text attachments", () => {
    const moved = moveNote(
      {
        [p]: "[other](b.md)\n[attachment](a.assets/t.txt)",
        "raw/Inbox/a.assets/t.txt": "asset",
      },
      p,
      "raw/Projects/deep/a.md",
    );
    expect(moved.files["raw/Projects/deep/a.md"]).toBe(
      "[other](../../Inbox/b.md)\n[attachment](a.assets/t.txt)",
    );
    expect(moved.files["raw/Projects/deep/a.assets/t.txt"]).toBe("asset");
  });
  it("preserves URL escapes and rejects collisions and unknown structured references", () => {
    expect(
      rewriteMarkdown(
        "[x](../Inbox/%E4%B8%AD.md)",
        "raw/Areas/x.md",
        "raw/Areas/x.md",
        new Map([["raw/Inbox/中.md", "raw/Projects/中.md"]]),
      ),
    ).toBe("[x](../Projects/%E4%B8%AD.md)");
    expect(() =>
      moveNote({ [p]: "", "raw/Areas/A.md": "" }, p, "raw/Areas/a.md"),
    ).toThrow();
    expect(() =>
      moveNote(
        { [p]: "", "derived/graph.json": JSON.stringify({ path: p }) },
        p,
        "raw/Areas/a.md",
      ),
    ).toThrow();
  });
});
