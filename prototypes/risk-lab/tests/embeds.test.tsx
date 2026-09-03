import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "../src/MarkdownPreview";
import { parsePreview } from "../src/core/preview";
import { selectSection } from "../src/core/embeds";
import { moveNote } from "../src/core/paths";

const owner = "raw/Inbox/总览.md",
  child = "raw/Areas/主题.md";
const render = (source: string, extra: Record<string, string> = {}) => {
  const files = Object.freeze({ [owner]: source, ...extra });
  const original = JSON.stringify(files);
  const result = renderToStaticMarkup(
    <MarkdownPreview
      source={source}
      owner={owner}
      files={files}
      onOpen={() => {
        throw new Error("Rendering must not navigate");
      }}
    />,
  );
  expect(JSON.stringify(files)).toBe(original);
  return result;
};
describe("portable document transclusion", () => {
  it("expands standalone Markdown without copying frontmatter into the host", () => {
    const html = render(`![[${child}|主题来源]]`, {
      [child]: "---\ntitle: 属性\n---\n# 主题\n\n具体内容。",
    });
    expect(html).toContain('class="note-embed"');
    expect(html).toContain("来源：主题来源</button>");
    expect(html).toContain("具体内容。");
    expect(html).not.toContain("文档属性");
    expect(html).not.toMatch(/<p>\s*<section/);
  });
  it("resolves both ordinary and Wiki links from the source note directory", () => {
    const html = render(`![[${child}]]`, {
      [child]: "[普通](邻居.md) [[邻居|别名]]",
      "raw/Areas/邻居.md": "正确来源",
      "raw/Inbox/邻居.md": "同名但错误",
    });
    expect(html.match(/title="raw\/Areas\/邻居.md"/g)).toHaveLength(2);
    expect(html).not.toContain('title="raw/Inbox/邻居.md"');
  });
  it("selects a heading and descendants, excluding later peers and earlier prose", () => {
    const html = render(`![[${child}#主题]]`, {
      [child]:
        "前言不应展开\n\n## 主题\n\n节内正文\n\n### 细节\n\n细节正文\n\n## 下一节\n\n后文不应展开",
    });
    expect(html).toContain("节内正文");
    expect(html).toContain("细节正文");
    expect(html).not.toContain("前言不应展开");
    expect(html).not.toContain("后文不应展开");
  });
  it("supports duplicate-heading slugs and headings inside callouts", () => {
    const source =
      "## 标题\n\n第一段\n\n## 标题\n\n第二段\n\n> [!note]\n> ### 内部\n> 内部正文";
    expect(selectSection(parsePreview(source), "标题-1").slug).toBe("标题-1");
    const html = render(`![[${child}#标题-1]]\n\n![[${child}#内部]]`, {
      [child]: source,
    });
    expect(html).not.toContain("第一段");
    expect(html).toContain("第二段");
    expect(html).toContain("内部正文");
  });
  it("keeps out-of-section reference and footnote definitions with scoped targets", () => {
    const html = render(`![[${child}#节]]\n\n![[${child}#节]]`, {
      [child]:
        "## 节\n\n[链接][a] 注释[^n]\n\n## 后续\n\n[a]: 邻居.md\n[^n]: 该脚注属于来源文档",
      "raw/Areas/邻居.md": "# 邻居",
    });
    expect(html.match(/title="raw\/Areas\/邻居.md"/g)).toHaveLength(2);
    expect(html).toContain("该脚注属于来源文档");
    expect(html).toContain('class="footnotes"');
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("isolates definition labels from those of the host", () => {
    const html = render(`[主链接][a]\n\n![[${child}]]\n\n[a]: 主文档.md`, {
      [child]: "[子链接][a]\n\n[a]: 子文档.md",
      "raw/Inbox/主文档.md": "主文档",
      "raw/Areas/子文档.md": "子文档",
    });
    expect(html).toContain('title="raw/Inbox/主文档.md">主链接');
    expect(html).toContain('title="raw/Areas/子文档.md">子链接');
  });
  it("retains host heading targets when the same title occurs in embedded documents", () => {
    const html = render(`![[${child}]]\n\n# 标题\n\n[[#标题|主标题]]`, {
      [child]: "# 标题",
    });
    expect(html).toContain('id="user-content-标题"');
    expect(html).toContain('id="user-content-embed:1:标题"');
    expect(html).toContain("主标题</button>");
  });
  it("supports finite self-section embedding but stops a recursive whole-document link", () => {
    const html = render("![[#细节]]\n\n## 细节\n\n一段内容\n\n![[总览]]");
    expect(html).toContain("一段内容");
    expect(html).toContain("循环引用已停止");
  });
  it("stops cross-document cycles without losing independent host content", () => {
    const html = render(`主文档\n\n![[${child}]]`, {
      [child]: `来源文档\n\n![[${owner}]]`,
    });
    expect(html).toContain("主文档");
    expect(html).toContain("来源文档");
    expect(html).toContain("循环引用已停止");
  });
  it("caps nested expansion", () => {
    const files = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `raw/Areas/${i}.md`,
        `层${i}\n\n![[raw/Areas/${i + 1}.md]]`,
      ]),
    );
    const html = render("![[raw/Areas/0.md]]", files);
    expect(html.match(/class="note-embed"/g)).toHaveLength(4);
    expect(html).toContain("嵌套过深");
  });
  it("caps fan-out and total source size", () => {
    const html = render(
      Array.from({ length: 25 }, () => `![[${child}]]`).join("\n\n"),
      { [child]: "短正文" },
    );
    expect(html.match(/class="note-embed"/g)).toHaveLength(24);
    expect(html).toContain("嵌入数量超过");
    expect(render(`![[${child}]]`, { [child]: "x".repeat(200001) })).toContain(
      "嵌入内容超过",
    );
  });
  it("keeps inline references as links without breaking paragraph markup", () => {
    const html = render(`前半句 ![[${child}]] 后半句`, {
      [child]: "不直接插入",
    });
    expect(html).not.toContain("不直接插入");
    expect(html).toContain("打开原文]</button>");
    expect(html).not.toContain("<section");
  });
  it("keeps code, escaped syntax and math literal", () => {
    const html = render(
      `\`![[${child}]]\`\n\n\\![[${child}]]\n\n$![[${child}]]$`,
      { [child]: "不应出现" },
    );
    expect(html).not.toContain("不应出现");
    expect(html).not.toContain('class="note-embed"');
  });
  it.each([
    "不存在",
    "https://example.org/note.md",
    "../../../../etc/passwd",
    "文档.pdf",
    "#^opaque",
    child + "#不存在",
  ])("shows unavailable target %s without fetching", (target) => {
    const html = render(`![[${target}]]`, { [child]: "# 标题" });
    expect(html).toContain("嵌入：");
    expect(html).not.toMatch(/<(img|iframe|video|audio)\b/);
    expect(html).not.toContain('class="note-embed"');
  });
  it("keeps encoded filename hashes valid in source-navigation links", () => {
    const html = render("![[raw/Areas/a%23b.md]]", {
      "raw/Areas/a#b.md": "# 正文",
    });
    expect(html).toContain('title="raw/Areas/a#b.md"');
    expect(html).not.toContain("标题未找到");
  });
  it("follows rewritten paths after a source document moves", () => {
    const { files } = moveNote(
      { [owner]: `![[${child}]]`, [child]: "# 可移动的正文" },
      child,
      "raw/Projects/新主题.md",
    );
    expect(render(files[owner], files)).toContain("可移动的正文");
    expect(files[owner]).toBe("![[raw/Projects/新主题.md]]");
  });
  it("shares the math budget across host and embedded content", () => {
    const formulas = Array.from({ length: 120 }, () => "$x$").join(" ");
    const html = render(formulas + `\n\n![[${child}]]`, { [child]: formulas });
    expect(html.match(/class="katex"/g)).toHaveLength(200);
    expect(html).toContain("公式超过预览上限");
  });
  it("applies the same HTML and math trust boundary to embedded documents", () => {
    const html = render(`![[${child}]]`, {
      [child]:
        '<script>alert(1)</script>\n\n<img src="https://example.org/track" onerror="alert(1)">\n\n$\\href{javascript:alert(1)}{bad}$\n\n![image](https://example.org/track)',
    });
    expect(html).not.toMatch(/<(script|img|iframe)\b/);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('src="https://example.org/track"');
  });
});
