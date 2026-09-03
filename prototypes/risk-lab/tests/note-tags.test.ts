import { describe, expect, it } from "vitest";
import { noteTags, setNoteTags } from "../src/core/note-metadata";

describe("portable note tags", () => {
  it("reads a scalar or list from readable OFM front matter", () => {
    expect(noteTags("---\ntags: 健康\n---\n")).toEqual(["健康"]);
    expect(noteTags("---\ntags: [健康, 睡眠]\n---\n")).toEqual([
      "健康",
      "睡眠",
    ]);
  });
  it("does not infer tags from ordinary body text", () => {
    expect(noteTags("#健康 不等于标签\n")).toEqual([]);
  });
  it("rejects malformed, duplicate, and unsafe tag fields", () => {
    expect(() => noteTags("---\ntags: {name: 健康}\n---\n")).toThrow("tags");
    expect(() => noteTags("---\ntags: [健康, 健康]\n---\n")).toThrow("重复");
    expect(() => noteTags("---\ntags: ['坏,标签']\n---\n")).toThrow("标签");
  });
  it("adds and edits an inline list while retaining BOM, CRLF and comments", () => {
    const source =
      "\uFEFF---\r\ntitle: 保留\r\ntags: [旧] # 标签\r\n---\r\nbody\r\n";
    expect(setNoteTags(source, ["健康", "睡眠"])).toBe(
      '\uFEFF---\r\ntitle: 保留\r\ntags: ["健康", "睡眠"] # 标签\r\n---\r\nbody\r\n',
    );
    expect(setNoteTags("# new\n", ["收集"])).toBe(
      '---\ntags: ["收集"]\n---\n# new\n',
    );
    expect(() => setNoteTags("---\ntags:\n  - 旧\n---\n", ["新"])).toThrow(
      "块状",
    );
  });
});
