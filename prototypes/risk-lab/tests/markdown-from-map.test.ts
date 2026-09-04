import { describe, expect, it } from "vitest";
import { markdownFromMap } from "../src/core/markdown-from-map";
import { topic } from "../src/core/formats";

describe("manual map Markdown generation", () => {
  it("writes portable title, hierarchy and node bodies without relation claims", () => {
    const root = topic("减脂");
    root.body = "总览";
    root.children = [
      { ...topic("睡眠"), body: "睡够", children: [topic("作息")] },
    ];
    expect(markdownFromMap({ title: "减脂笔记", root })).toBe(
      '---\ntitle: "减脂笔记"\n---\n\n# 减脂\n\n总览\n\n## 睡眠\n\n睡够\n\n### 作息\n',
    );
  });

  it("keeps deeply nested maps readable within Markdown's six heading levels", () => {
    let node = topic("根"), cursor = node;
    for (let index = 1; index <= 7; index++) {
      const child = topic(`层 ${index}`);
      cursor.children = [child];
      cursor = child;
    }
    const markdown = markdownFromMap({ title: "深层", root: node });
    expect(markdown).toContain("###### 层 7");
    expect(markdown).not.toContain("#######");
  });
});
