import { describe, expect, it } from "vitest";
import { isFavorite, setFavorite } from "../src/core/note-metadata";

describe("portable note metadata", () => {
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
});
