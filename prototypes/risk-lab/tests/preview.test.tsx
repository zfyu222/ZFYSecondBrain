import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "../src/MarkdownPreview";
import { inspectMarkdown, resolveNoteLink } from "../src/core/preview";

const owner = "raw/Inbox/开始.md";
const files = {
  [owner]: "# 开始\n\n## 当前 **标题**\n\n## 当前 标题",
  "raw/Areas/健康/睡眠.md": "# 睡眠\n\n## 睡眠与食欲",
  "raw/Inbox/邻居.md": "# 邻居",
  "raw/Inbox/纯导图.opml": "<opml/>",
  "raw/Inbox/笔记.assets/图.svg": "<svg/>",
};
const render = (source: string) =>
  renderToStaticMarkup(
    <MarkdownPreview
      source={source}
      owner={owner}
      files={{ ...files, [owner]: source }}
      onOpen={() => {
        throw new Error("Rendering must not navigate or write");
      }}
    />,
  );

describe("portable note navigation", () => {
  it("resolves root, relative, percent-encoded, same-file and OPML paths", () => {
    expect(
      resolveNoteLink("raw/Areas/健康/睡眠#睡眠与食欲", owner, files),
    ).toEqual({
      kind: "note",
      path: "raw/Areas/健康/睡眠.md",
      heading: "睡眠与食欲",
    });
    expect(
      resolveNoteLink(
        "../Areas/健康/睡眠.md?view=read#睡眠与食欲",
        owner,
        files,
      ),
    ).toMatchObject({ kind: "note", path: "raw/Areas/健康/睡眠.md" });
    expect(
      resolveNoteLink("%E9%82%BB%E5%B1%85.md", owner, files),
    ).toMatchObject({ kind: "note", path: "raw/Inbox/邻居.md" });
    expect(resolveNoteLink("#当前 标题", owner, files)).toMatchObject({
      kind: "note",
      path: owner,
      heading: "当前 标题",
    });
    expect(resolveNoteLink("纯导图.opml", owner, files)).toMatchObject({
      kind: "note",
      path: "raw/Inbox/纯导图.opml",
    });
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///C:/notes.md",
    "//example.org/path",
    "/api/snapshot",
    "../../../../outside",
    "%2e%2e/%2e%2e/%2e%2e/x",
    "x%00.md",
    "x%ZZ.md",
    "#^block-id",
    "x\\y",
  ])("blocks unsupported target %s", (target) => {
    expect(resolveNoteLink(target, owner, files).kind).toBe("blocked");
  });
  it("reports missing notes and unsupported attachments, never guesses a global basename", () => {
    expect(resolveNoteLink("睡眠", owner, files)).toEqual({
      kind: "missing",
      path: "raw/Inbox/睡眠",
    });
    expect(resolveNoteLink("笔记.assets/图.svg", owner, files).kind).toBe(
      "attachment",
    );
    expect(resolveNoteLink("RAW/Inbox/邻居.md", owner, files).kind).toBe(
      "missing",
    );
  });
  it("allows deliberate ordinary external links", () => {
    expect(
      resolveNoteLink("https://example.org/notes?q=abc", owner, files),
    ).toEqual({ kind: "external", href: "https://example.org/notes?q=abc" });
    expect(resolveNoteLink("mailto:test@example.org", owner, files).kind).toBe(
      "external",
    );
  });
});

describe("safe OFM subset rendering", () => {
  it("renders Wiki aliases and ordinary links as in-app actions", () => {
    const html = render("[[raw/Areas/健康/睡眠|睡眠原理]] 与 [邻居](邻居.md)");
    expect(html).toContain('class="note-link"');
    expect(html).toContain("睡眠原理</button>");
    expect(html).toContain("邻居</button>");
    expect(html).not.toContain("target=");
  });
  it("keeps code and escaped Wiki syntax literal", () => {
    const html = render("`[[邻居]]`\n\n\\[[邻居]]\n\n```md\n[[邻居]]\n```");
    expect(html).not.toContain('class="note-link"');
    expect(html).toContain("[[邻居]]");
  });
  it("renders current and cross-document headings, with explicit missing-heading feedback", () => {
    const html = render(
      "# 当前标题\n\n[[#当前标题|此处]] [[raw/Areas/健康/睡眠#睡眠与食欲|另一个标题]] [[邻居#不存在|旧标题]]",
    );
    expect(html).toContain('id="user-content-当前标题"');
    expect(html).toContain("此处</button>");
    expect(html).toContain("另一个标题</button>");
    expect(html).toContain("标题未找到");
  });
  it("uses readable heading slugs, including duplicate titles and inline formatting", () => {
    expect(inspectMarkdown(files[owner]).headings).toEqual([
      { title: "开始", slug: "开始" },
      { title: "当前 标题", slug: "当前-标题" },
      { title: "当前 标题", slug: "当前-标题-1" },
    ]);
  });
  it.each(["---", "..."])(
    "separates Front Matter ending %s from the reading body without changing the source",
    (close) => {
      const source = `---\r\ntitle: 明确标题\r\nfavorite: true\r\ntags: [健康, 思考]\r\n${close}\r\n# 正文`;
      const original = source;
      expect(inspectMarkdown(source).metadata).toEqual({
        title: "明确标题",
        favorite: true,
        tags: ["健康", "思考"],
      });
      const html = render(source);
      expect(html).toContain("文档属性</summary>");
      expect(html).toContain("正文</h1>");
      expect(html).not.toContain("<hr");
      expect(source).toBe(original);
    },
  );
  it("surfaces invalid properties while retaining the original and readable body", () => {
    const html = render("---\ntitle: A\ntitle: B\n---\n# 正文");
    expect(html).toContain('role="alert"');
    expect(html).toContain("正文</h1>");
    expect(inspectMarkdown("---\ntitle: unfinished").metadataError).toContain(
      "未闭合",
    );
  });
  it("shows missing links without issuing service or file requests", () => {
    const html = render(
      "[[不存在|失效笔记]] [越界](../../../../etc/passwd) [API](/api/snapshot)",
    );
    expect(html).toContain("未找到");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<button");
  });
  it("prevents automatic remote/local media loads for every community embed type", () => {
    const html = render(
      "![[片段]] ![[图.png]] ![[视频.mp4]] ![[录音.mp3]] ![[文档.pdf]] ![远程图](https://example.org/tracker.png)",
    );
    expect(html).toContain("嵌入：片段");
    expect(html).toContain("嵌入：文档.pdf");
    expect(html).not.toMatch(/<(img|iframe|audio|video|source|link)\b/);
    expect(html).not.toContain("src=");
  });
  it("does not execute raw HTML, scripts, handlers or unsafe schemes", () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="https://example.org/tracker" onerror="evil()">\n\n[危险](javascript:alert) [[javascript:alert|坏链接]] <iframe src="file:///C:/secret"></iframe>',
    );
    expect(html).not.toMatch(/<(script|img|iframe)\b/);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("src=");
  });
  it("retains GFM tables, task lists, strikethrough and safe footnote targets", () => {
    const html = render(
      "| A | B |\n| --- | --- |\n| 一 | 二 |\n\n- [x] 完成\n\n~~旧观点~~ 脚注[^n]\n\n[^n]: 注释",
    );
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>旧观点</del>");
    expect(html).toContain('href="#user-content-fn-n"');
    expect(html).toContain('id="user-content-fn-n"');
  });
  it("protects external links from opener and referrer access", () => {
    expect(render("[外部](https://example.org/)")).toContain(
      'rel="noopener noreferrer"',
    );
  });
});
