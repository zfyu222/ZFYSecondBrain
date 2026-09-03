import { describe, expect, it } from "vitest";
import {
  editMap,
  parseRelations,
  serializeRelations,
  topic,
  type Relation,
} from "../src/core/formats";

const map = {
  title: "T",
  root: { ...topic("根"), children: [topic("甲"), topic("乙")] },
};
const source = `# 文档说明
version: 1 # schema 注释
map: "./a.opml" # 文件引用
relations:
  - from: '/根[1]/甲[1]' # 第一条来源
    to: '/根[1]/乙[1]'
    type: 相关 # 第一条理由
    status: confirmed
  - from: '/根[1]/乙[1]' # 第二条来源
    to: '/根[1]/甲[1]'
    type: 支持 # 第二条理由
    status: confirmed
# 文档结尾
`;
describe("relation YAML preservation", () => {
  it("returns unchanged source byte-for-byte, including CRLF, quotes and comments", () => {
    const text = source.replaceAll("\n", "\r\n");
    expect(
      serializeRelations("a.opml", parseRelations(text, map), {
        text,
        indices: [0, 1],
      }),
    ).toBe(text);
  });
  it("does not rewrite relation YAML for unrelated node body edits", () => {
    const relations = parseRelations(source, map);
    const edited = editMap(map, relations, (next) => {
      next.root.body = "仅修改正文";
    });
    expect(edited.relationOrigins).toEqual([0, 1]);
    expect(
      serializeRelations("a.opml", edited.relations, {
        text: source,
        indices: edited.relationOrigins,
      }),
    ).toBe(source);
  });
  it("retains inline and document comments while remapping renamed endpoints", () => {
    const edited = editMap(map, parseRelations(source, map), (next) => {
      next.root.children[0].text = "新甲";
    });
    const result = serializeRelations("a.opml", edited.relations, {
      text: source,
      indices: edited.relationOrigins,
    });
    expect(parseRelations(result, edited.map)).toEqual(edited.relations);
    for (const comment of [
      "文档说明",
      "schema 注释",
      "文件引用",
      "第一条来源",
      "第一条理由",
      "第二条来源",
      "第二条理由",
      "文档结尾",
    ])
      expect(result).toContain(comment);
    expect(result).toContain("'/根[1]/新甲[1]'");
  });
  it("preserves the surviving relation's own comments after deleting another relation", () => {
    const relations = parseRelations(source, map);
    const result = serializeRelations("a.opml", [relations[1]], {
      text: source,
      indices: [1],
    });
    expect(parseRelations(result, map)).toEqual([relations[1]]);
    expect(result).toContain("第二条来源");
    expect(result).toContain("第二条理由");
    expect(result).toContain("文档说明");
  });
  it("adds a new relation without rebuilding existing commented nodes", () => {
    const relations = parseRelations(source, map);
    const added: Relation = {
      from: "/根[1]",
      to: "/根[1]/甲[1]",
      type: "例子",
      status: "confirmed",
    };
    const result = serializeRelations("a.opml", [...relations, added], {
      text: source,
      indices: [0, 1, null],
    });
    expect(parseRelations(result, map)).toEqual([...relations, added]);
    expect(result).toContain("第一条理由");
    expect(result).toContain("第二条理由");
  });
  it("distinguishes identical relations by explicit operation-local origins, not guessed IDs", () => {
    const duplicates = source
      .replace("type: 支持", "type: 相关")
      .replace("- from: '/根[1]/乙[1]'", "- from: '/根[1]/甲[1]'")
      .replace("to: '/根[1]/甲[1]'", "to: '/根[1]/乙[1]'");
    const relations = parseRelations(duplicates, map);
    expect(relations[0]).toEqual(relations[1]);
    const result = serializeRelations("a.opml", [relations[1], relations[0]], {
      text: duplicates,
      indices: [1, 0],
    });
    expect(result.indexOf("第二条理由")).toBeLessThan(
      result.indexOf("第一条理由"),
    );
    expect(result).not.toContain("indices:");
  });
  it("preserves the quoted map reference comment when its filename changes", () => {
    const result = serializeRelations(
      "新文件.opml",
      parseRelations(source, map),
      { text: source, indices: [0, 1] },
    );
    expect(result).toContain('map: "./新文件.opml" # 文件引用');
  });
  it("preserves CRLF during actual edits", () => {
    const text = source.replaceAll("\n", "\r\n");
    const result = serializeRelations("b.opml", parseRelations(text, map), {
      text,
      indices: [0, 1],
    });
    expect(result.replaceAll("\r\n", "")).not.toContain("\n");
  });
  it.each(
    [[0], [0, 0], [-1, 1], [0, 99], [0, 0.5]].map((indices) => ({ indices })),
  )("refuses invalid origin mappings $indices", ({ indices }) => {
    expect(() =>
      serializeRelations("a.opml", parseRelations(source, map), {
        text: source,
        indices,
      }),
    ).toThrow("关系来源");
  });
  it("keeps empty existing files empty and supports intentional first relation creation", () => {
    expect(
      serializeRelations("a.opml", [], { text: "\r\n", indices: [] }),
    ).toBe("\r\n");
    const relations = parseRelations(source, map).slice(0, 1);
    expect(
      parseRelations(
        serializeRelations("a.opml", relations, { text: "", indices: [null] }),
        map,
      ),
    ).toEqual(relations);
  });
  it("preserves document comments when removing every relation", () => {
    const result = serializeRelations("a.opml", [], {
      text: source,
      indices: [],
    });
    expect(parseRelations(result, map)).toEqual([]);
    expect(result).toContain("文档说明");
    expect(result).toContain("文档结尾");
  });
});
