import { describe, expect, it } from "vitest";
import { mapFromMarkdown } from "../src/core/map-from-markdown";

describe("manual Markdown map generation", () => {
  it("preserves heading hierarchy and prose without inventing relations", () => {
    const map = mapFromMarkdown(
      "减脂笔记",
      "---\ntitle: 减脂笔记\n---\n引言\n\n# 睡眠\n睡眠正文\n\n## 作息\n建议\n\n# 饮食\n饮食正文",
    );
    expect(map.title).toBe("减脂笔记");
    expect(map.root.body).toBe("引言");
    expect(map.root.children.map((node) => node.text)).toEqual(["睡眠", "饮食"]);
    expect(map.root.children[0]).toMatchObject({
      body: "睡眠正文",
      children: [{ text: "作息", body: "建议" }],
    });
  });

  it("does not mistake fenced Markdown examples for document headings", () => {
    const map = mapFromMarkdown("示例", "```md\n# 代码标题\n```\n\n# 正文标题");
    expect(map.root.children.map((node) => node.text)).toEqual(["正文标题"]);
    expect(map.root.body).toContain("# 代码标题");
  });
});
