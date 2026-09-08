import { describe, expect, it } from "vitest";
import { isFavorite, noteTitle, setFavorite, setNoteTags, setNoteTitle, setSoftLinks, softLinks } from "../src/core/note-metadata";

describe("portable note metadata", () => {
  it("uses a readable title without renaming the file", () => {
    const source = setNoteTitle("# 原文\n", "显示标题");
    expect(noteTitle(source)).toBe("显示标题");
  });
  it("stores soft link entrances as portable readable paths", () => {
    const updated = setSoftLinks("# 原文\n", ["raw/Projects/项目A", "raw/Areas/健康/"]);
    expect(softLinks(updated)).toEqual(["raw/Projects/项目A", "raw/Areas/健康"]);
    expect(updated).toContain('soft_links: ["raw/Projects/项目A", "raw/Areas/健康"]');
  });
  it("adds a readable favorite field without a database-only identifier", () => {
    const source = "# Note\n";
    const changed = setFavorite(source, true);
    expect(changed).toBe("---\nfavorite: true\n---\n# Note\n");
    expect(isFavorite(changed)).toBe(true);
  });
  it("updates only favorite while retaining BOM, CRLF and nearby metadata", () => {
    const source =
      "\uFEFF---\r\n# note comment\r\ntitle: 保留\r\nfavorite: false # 可读\r\n---\r\n# 正文\r\n";
    const changed = setFavorite(source, true);
    expect(changed).toBe(
      "\uFEFF---\r\n# note comment\r\ntitle: 保留\r\nfavorite: true # 可读\r\n---\r\n# 正文\r\n",
    );
    expect(isFavorite(changed)).toBe(true);
  });
  it("keeps an explicit false field on un-favorite", () => {
    const source = "---\nfavorite: true\n---\ntext\n";
    expect(setFavorite(source, false)).toBe(
      "---\nfavorite: false\n---\ntext\n",
    );
    expect(isFavorite(setFavorite(source, false))).toBe(false);
  });
  it("refuses malformed or non-boolean metadata without guessing", () => {
    expect(() => setFavorite("---\nfavorite: yes\n---\n", true)).toThrow(
      "favorite",
    );
    expect(() => setFavorite("---\nfavorite: true\n", false)).toThrow("未闭合");
  });
  it("changes only known fields and retains unknown OFM fields verbatim", () => {
    const source =
      "---\n" +
      "title: 旧标题\n" +
      "tags: [旧标签]\n" +
      "favorite: false\n" +
      "soft_links: [raw/Areas/旧入口]\n" +
      "custom_plugin:\n  color: blue\n  nested: [保留, 原样]\n" +
      "aliases:\n  - 别名\n---\n# 正文\n";
    const unknown = "custom_plugin:\n  color: blue\n  nested: [保留, 原样]\naliases:\n  - 别名\n";
    const changed = setSoftLinks(
      setFavorite(setNoteTags(setNoteTitle(source, "新标题"), ["新标签"]), true),
      ["raw/Projects/新入口"],
    );
    expect(changed).toContain(unknown);
    expect(changed).toContain("title: \"新标题\"");
    expect(changed).toContain('tags: ["新标签"]');
    expect(changed).toContain("favorite: true");
    expect(changed).toContain('soft_links: ["raw/Projects/新入口"]');
  });
});
