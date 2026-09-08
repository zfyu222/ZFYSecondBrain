import { describe, expect, it } from "vitest";
import { standardMarkdown } from "../src/core/standard-markdown";

const owner = "raw/Inbox/今天.md";

describe("standard Markdown export", () => {
  it("converts document Wiki links to relative Markdown links", () => {
    expect(standardMarkdown("见 [[raw/Areas/睡眠#结论|睡眠结论]]", owner)).toBe(
      "见 [睡眠结论](../Areas/睡眠.md#结论)",
    );
  });
  it("keeps attachment extensions and emits a standard image when applicable", () => {
    expect(standardMarkdown("![[今天.assets/图 1.png|示意图]]\n![[raw/Areas/a.pdf]]", owner)).toBe(
      "![示意图](今天.assets/图%201.png)\n[a.pdf](../Areas/a.pdf)",
    );
  });
  it("does not alter escaped syntax, code, math, or existing Markdown links", () => {
    const source = "\\[[raw/Areas/a]]\n\n`[[raw/Areas/a]]`\n\n```md\n[[raw/Areas/a]]\n```\n\n$[[raw/Areas/a]]$\n\n[已有](../Areas/a.md)\n\n[[raw/Areas/a]]";
    const expected = "\\[[raw/Areas/a]]\n\n`[[raw/Areas/a]]`\n\n```md\n[[raw/Areas/a]]\n```\n\n$[[raw/Areas/a]]$\n\n[已有](../Areas/a.md)\n\n[a](../Areas/a.md)";
    expect(standardMarkdown(source, owner)).toBe(expected);
  });
  it("uses a readable ordinary link for non-image embeds", () => {
    expect(standardMarkdown("![[raw/Areas/正文]]", owner)).toBe("[正文](../Areas/正文.md)");
  });
});
