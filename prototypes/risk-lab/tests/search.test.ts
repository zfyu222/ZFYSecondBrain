import { describe, expect, it } from "vitest";
import { matchesNoteSearch } from "../src/core/search";

describe("local note search", () => {
  const source = "---\ntags: [健康, 睡眠]\n---\n本月减脂速度较慢";
  it("combines case-insensitive text terms and multiple OFM tag filters", () => {
    expect(
      matchesNoteSearch("raw/Areas/睡眠笔记", source, "减脂 #健康 #睡眠", false),
    ).toBe(true);
    expect(
      matchesNoteSearch("raw/Areas/睡眠笔记", source, "减脂 #健康 #运动", false),
    ).toBe(false);
    expect(
      matchesNoteSearch("raw/Areas/NOTE", source, "note #健康", false),
    ).toBe(true);
  });
  it("excludes archived notes unless the search explicitly includes them", () => {
    expect(
      matchesNoteSearch("raw/Archive/旧笔记", source, "减脂", false),
    ).toBe(false);
    expect(
      matchesNoteSearch("raw/Archive/旧笔记", source, "减脂", true),
    ).toBe(true);
  });
});
