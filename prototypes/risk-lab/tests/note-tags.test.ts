import { describe, expect, it } from "vitest";
import { noteTags } from "../src/core/note-metadata";

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
});
