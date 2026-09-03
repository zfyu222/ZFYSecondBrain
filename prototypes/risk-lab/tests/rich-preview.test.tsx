import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "../src/MarkdownPreview";
import { inspectMarkdown } from "../src/core/preview";

const owner = "raw/Inbox/阅读测试.md";
const render = (source: string) =>
  renderToStaticMarkup(
    <MarkdownPreview
      source={source}
      owner={owner}
      files={{ [owner]: source, "raw/Inbox/邻居.md": "# 邻居" }}
      onOpen={() => {
        throw new Error("Preview must not navigate");
      }}
    />,
  );

describe("OFM callouts", () => {
  it.each(["note", "warning", "tip", "DANGER", "自定义"])(
    "renders %s with a default title",
    (type) => {
      const html = render(`> [!${type}]\n> 原文中的提示。`);
      expect(html).toContain('class="callout"');
      expect(html).toContain(`data-callout-type="${type.toLowerCase()}"`);
      expect(html).toContain("原文中的提示。");
      expect(html).not.toContain("<details");
    },
  );
  it.each(["+", "-"])("retains the %s default fold state", (fold) => {
    const html = render(`> [!note]${fold} **摘要**\n> 内容 [[邻居]]`);
    expect(html).toContain("<details");
    expect(html.includes('open=""')).toBe(fold === "+");
    expect(html).toContain(
      '<summary class="callout-title"><strong>摘要</strong></summary>',
    );
    expect(html).toContain("邻居</button>");
  });
  it("retains nested callouts, lists and heading targets", () => {
    const html = render(
      "> [!note] 总结\n> ## 子标题\n> - 要点\n>\n> > [!tip]- 细节\n> > 更多内容\n\n[[#子标题|跳转]]",
    );
    expect(html.match(/class="callout"/g)).toHaveLength(2);
    expect(html).toContain('<h2 id="user-content-子标题">');
    expect(html).toContain("跳转</button>");
    expect(html).toMatch(/<li>\s*(?:<p>)?要点(?:<\/p>)?\s*<\/li>/);
  });
  it.each([
    "> 普通引用",
    "> \\[!note]\n> 原样",
    "> &#91;!note]\n> 原样",
    "```md\n> [!note]\n```",
  ])("does not transform escaped or literal syntax: %s", (source) => {
    expect(render(source)).not.toContain('class="callout"');
  });
  it("does not trust HTML or external embeds inside titles or bodies", () => {
    const html = render(
      '> [!note]- <img src="https://example.org/x" onerror="evil()">\n> ![[视频.mp4]]\n> <script>evil()</script>',
    );
    expect(html).not.toMatch(/<(img|video|script)\b/);
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("src=");
  });
});

describe("OFM highlighted text", () => {
  it("preserves Wiki aliases and math text in readable heading targets", () => {
    const source = "# [[邻居|邻居别名]] 与 $x$\n\n[[#邻居别名 与 x|跳转]]";
    expect(inspectMarkdown(source).headings).toEqual([
      { title: "邻居别名 与 x", slug: "邻居别名-与-x" },
    ]);
    expect(render(source)).toContain('id="user-content-邻居别名-与-x"');
    expect(render(source)).toContain("跳转</button>");
  });
  it("supports emphasis, in-app links and CJK inside highlights", () => {
    const html = render("==重要 **结论** 和 [[邻居]]==");
    expect(html).toContain("<mark>重要 <strong>结论</strong>");
    expect(html).toContain("邻居</button></mark>");
  });
  it("keeps inline code, fenced code, escaped and unmatched delimiters literal", () => {
    const html = render(
      "`==代码==`\n\n```md\n==代码==\n```\n\n\\==转义\\==\n\n==未闭合",
    );
    expect(html).not.toContain("<mark>");
    expect(html).toContain("==未闭合");
  });
  it("uses the same heading text and slug in inspection and rendering", () => {
    const source = "# ==重要== **结论**\n\n[[#重要 结论|跳转]]";
    expect(inspectMarkdown(source).headings).toEqual([
      { title: "重要 结论", slug: "重要-结论" },
    ]);
    expect(render(source)).toContain('id="user-content-重要-结论"');
    expect(render(source)).toContain("跳转</button>");
  });
});

describe("bounded local math rendering", () => {
  it("renders inline, display and math fences with accessible MathML", () => {
    const html = render(
      "行内 $x^2$。\n\n$$\n\\frac{1}{2}\n$$\n\n```math\na+b\n```",
    );
    expect(html.match(/class="katex"/g)).toHaveLength(3);
    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(html).toContain("<math");
    expect(html).toContain('encoding="application/x-tex"');
  });
  it("does not parse math inside normal code, escaped dollars or frontmatter", () => {
    const html = render(
      "---\ntitle: $secret$\n---\n`$x$`\n\n```txt\n$x$\n```\n\n\\$x\\$",
    );
    expect(html).not.toContain('class="katex"');
  });
  it("shows bad formulas without losing surrounding prose", () => {
    const html = render("前文 $\\frac{1}{$ 后文");
    expect(html).toContain("katex-error");
    expect(html).toContain("前文");
    expect(html).toContain("后文");
  });
  it.each([
    String.raw`\href{javascript:alert(1)}{点击}`,
    String.raw`\href{https://example.org}{点击}`,
    String.raw`\includegraphics{https://example.org/tracker.png}`,
    String.raw`\htmlId{owned}{x}`,
    String.raw`\htmlStyle{background:url(https://example.org/x)}{x}`,
  ])("blocks trusted-only math commands: %s", (tex) => {
    const html = render(`$${tex}$`);
    expect(html).not.toMatch(/<(a|img|iframe)\b/);
    expect(html).not.toContain('id="owned"');
    expect(html).not.toContain("src=");
    expect(html).not.toMatch(/style="[^"]*(?:background|url\()/);
  });
  it("bounds recursive macros and does not share definitions between expressions", () => {
    expect(render(String.raw`$\def\loop{\loop}\loop$`)).toContain(
      "katex-error",
    );
    const first = render(String.raw`$\gdef\mysecret{xyz}\mysecret$`);
    expect(first).toContain('class="katex"');
    expect(render(String.raw`$\mysecret$`)).toContain("#cc0000");
  });
  it("keeps overlong formulas as source instead of rendering them", () => {
    const tex = "x".repeat(8193);
    const html = render(`$${tex}$\n\n\`\`\`math\n${tex}\n\`\`\``);
    expect(html).toContain("公式超过预览上限");
    expect(html).not.toContain('class="katex"');
    expect(html).toContain(tex);
  });
  it("caps formula count without omitting the excess source", () => {
    const html = render(Array.from({ length: 201 }, () => "$x$").join(" "));
    expect(html.match(/class="katex"/g)).toHaveLength(200);
    expect(html).toContain("公式超过预览上限");
  });
  it("caps total formula text even if each individual formula fits", () => {
    const html = render(
      Array.from({ length: 9 }, () => "$" + "x".repeat(8192) + "$").join(
        "\n\n",
      ),
    );
    expect(html.match(/class="katex"/g)).toHaveLength(8);
    expect(html).toContain("公式超过预览上限");
  });
});
