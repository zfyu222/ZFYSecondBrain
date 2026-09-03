import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { remarkDocumentEmbeds } from "./core/embeds";
import {
  inspectMarkdown,
  previewRemarkPlugins,
  resolveNoteLink,
} from "./core/preview";

// Sanitize untrusted markup first. Only KaTeX may generate math layout styles;
// trust:false disables its URL/image/HTML commands, including ordinary HTTPS.
const previewSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "section"],
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", "math-inline", "math-display", /^language-./]],
    a: [...(defaultSchema.attributes?.a ?? []), "dataNoteOwner"],
    section: [
      ["className", "note-embed", "footnotes"],
      ...(defaultSchema.attributes?.section ?? []).filter(
        (attribute) =>
          (Array.isArray(attribute) ? attribute[0] : attribute) !== "className",
      ),
      "dataEmbedPath",
    ],
    p: [
      ...(defaultSchema.attributes?.p ?? []),
      ["className", "embed-unavailable"],
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      [
        "className",
        "callout",
        "callout-title",
        "callout-body",
        "embed-heading",
      ],
      "dataCalloutType",
    ],
    details: [
      ...(defaultSchema.attributes?.details ?? []),
      ["className", "callout"],
      "dataCalloutType",
      "open",
    ],
    summary: [
      ...(defaultSchema.attributes?.summary ?? []),
      ["className", "callout-title"],
    ],
  },
};

export function MarkdownPreview({
  source,
  owner,
  files,
  onOpen,
}: {
  source: string;
  owner: string;
  files: Record<string, string>;
  onOpen: (path: string, heading?: string) => void;
}) {
  const inspected = useMemo(() => {
    try {
      return { ...inspectMarkdown(source), error: "" };
    } catch (error) {
      return {
        metadata: undefined,
        metadataError: "",
        headings: [],
        error: String(error),
      };
    }
  }, [source]);
  if (inspected.error)
    return (
      <div className="markdown-reading">
        <p role="alert">预览解析失败，原文未修改：{inspected.error}</p>
        <pre>{source}</pre>
      </div>
    );
  return (
    <div className="markdown-reading">
      {inspected.metadataError && (
        <p className="notice" role="alert">
          属性无法解析：{inspected.metadataError}
        </p>
      )}
      {inspected.metadata !== undefined && inspected.metadata !== null && (
        <details className="note-properties">
          <summary>文档属性</summary>
          <pre>{JSON.stringify(inspected.metadata, null, 2)}</pre>
        </details>
      )}
      <ReactMarkdown
        remarkPlugins={[
          ...previewRemarkPlugins,
          [remarkDocumentEmbeds, { owner, files }],
        ]}
        remarkRehypeOptions={{ clobberPrefix: "" }}
        rehypePlugins={[
          [rehypeSanitize, previewSchema],
          [
            rehypeKatex,
            { trust: false, maxSize: 20, maxExpand: 1000, strict: "ignore" },
          ],
        ]}
        skipHtml
        components={{
          a: ({ children, href, node }) => {
            // GFM footnote anchors refer to render-only, sanitized identifiers, not raw note IDs.
            if (
              href?.startsWith("#") &&
              (node?.properties.dataFootnoteRef !== undefined ||
                node?.properties.dataFootnoteBackref !== undefined)
            )
              return <a href={"#user-content-" + href.slice(1)}>{children}</a>;
            const linkedOwner = node?.properties.dataNoteOwner;
            const link = resolveNoteLink(
              href ?? "",
              typeof linkedOwner === "string" &&
                Object.hasOwn(files, linkedOwner)
                ? linkedOwner
                : owner,
              files,
            );
            if (link.kind === "external")
              return (
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            if (link.kind !== "note") {
              const reason =
                link.kind === "blocked"
                  ? link.reason
                  : link.kind === "missing"
                    ? "文档不存在：" + link.path
                    : "附件尚未支持：" + link.path;
              return (
                <span className="unavailable-link" title={reason}>
                  {children}
                  <small>
                    （{link.kind === "missing" ? "未找到" : "不可打开"}）
                  </small>
                </span>
              );
            }
            let heading: string | undefined;
            if (link.heading) {
              try {
                const headings = inspectMarkdown(files[link.path]).headings;
                heading =
                  headings.find((h) => h.title === link.heading)?.slug ??
                  headings.find((h) => h.slug === link.heading)?.slug;
              } catch {
                /* Opening the note remains possible; its preview will show a parse error. */
              }
              if (heading === undefined)
                return (
                  <span
                    className="unavailable-link"
                    title={"标题未找到：" + link.heading}
                  >
                    {children}
                    <small>（标题未找到）</small>
                  </span>
                );
            }
            return (
              <button
                type="button"
                className="note-link"
                title={link.path}
                onClick={() => onOpen(link.path, heading)}
              >
                {children}
              </button>
            );
          },
          img: ({ alt, src }) => (
            <span className="media-placeholder">
              [图片：{alt || src || "未知路径"} · 原型暂不加载附件]
            </span>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
