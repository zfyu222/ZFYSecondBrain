import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkWikiLink from "@flowershow/remark-wiki-link";
import remarkCallout, {
  type Options as CalloutOptions,
} from "@r4ai/remark-callout";
import { remarkHighlightMark } from "remark-highlight-mark";
import remarkMath from "remark-math";
import type { PluggableList, Plugin } from "unified";
import GithubSlugger from "github-slugger";
import type { Root } from "mdast";
import { pathSchema } from "./contracts";
import { safeYaml } from "./formats";

export type PreviewNode = {
  type: string;
  value?: string;
  lang?: string | null;
  position?: { start: { offset?: number } };
  depth?: number;
  identifier?: string;
  url?: string;
  children?: PreviewNode[];
  data?: {
    alias?: string;
    hName?: string;
    hProperties?: Record<string, unknown>;
    hChildren?: unknown[];
  };
};
export const previewWikiOptions = {
  format: "regular" as const,
  caseInsensitive: false,
};
export const previewFrontmatterOptions = [
  { type: "yaml", fence: { open: "---", close: "---" } },
  { type: "yaml", fence: { open: "---", close: "..." } },
];
const calloutOptions: CalloutOptions = {
  root: (callout) => ({
    tagName: callout.isFoldable ? "details" : "div",
    properties: {
      className: ["callout"],
      dataCalloutType: callout.type.toLowerCase(),
      ...(callout.isFoldable ? { open: !callout.defaultFolded } : {}),
    },
  }),
  title: (callout) => ({
    tagName: callout.isFoldable ? "summary" : "div",
    properties: { className: ["callout-title"] },
  }),
  body: { tagName: "div", properties: { className: ["callout-body"] } },
};
// The community transformer sees decoded text; protect escaped/entity markers
// without reimplementing its nested callout and inline-title handling.
const remarkSafeCallout: Plugin<[], Root> = function () {
  const transform = remarkCallout.call(this, calloutOptions);
  if (typeof transform !== "function") throw new Error("Callout 插件不可用");
  return (tree, file) => {
    const source = file.toString(),
      protectedNodes: PreviewNode[] = [];
    const protect = (node: PreviewNode) => {
      if (node.type === "blockquote") {
        const first = node.children?.[0]?.children?.[0];
        const offset = first?.position?.start.offset;
        if (
          first?.type === "text" &&
          first.value?.startsWith("[!") &&
          (offset === undefined || source.slice(offset, offset + 2) !== "[!")
        ) {
          node.type = "escapedBlockquote";
          protectedNodes.push(node);
        }
      }
      node.children?.forEach(protect);
    };
    protect(tree as unknown as PreviewNode);
    try {
      return transform(tree, file, (error) => {
        if (error) throw error;
      });
    } finally {
      protectedNodes.forEach((node) => {
        node.type = "blockquote";
      });
    }
  };
};
export const previewRemarkPlugins: PluggableList = [
  remarkGfm,
  [remarkFrontmatter, previewFrontmatterOptions],
  [remarkWikiLink, previewWikiOptions],
  remarkHighlightMark,
  remarkMath,
  remarkSafeCallout,
  remarkPreviewPolicy,
];
const parser = unified().use(remarkParse).use(previewRemarkPlugins);
export const textOf = (node: PreviewNode): string =>
  node.type === "wikiLink"
    ? (node.data?.alias ?? node.value ?? "")
    : (node.value ?? node.children?.map(textOf).join("") ?? "");
export function parsePreview(source: string) {
  return parser.runSync(parser.parse(source), source) as unknown as PreviewNode;
}
export function inspectMarkdown(source: string) {
  const tree = parsePreview(source);
  const first = tree.children?.[0];
  let metadata: unknown,
    metadataError = "";
  if (first?.type === "yaml") {
    try {
      metadata = safeYaml(first.value ?? "");
      if (
        metadata !== null &&
        (typeof metadata !== "object" || Array.isArray(metadata))
      )
        throw new Error("属性应为键值对象");
    } catch (error) {
      metadataError = String(error);
    }
  } else if (/^\uFEFF?---\r?\n/.test(source))
    metadataError = "Front Matter 未闭合，原文仍保留";
  const headings: { title: string; slug: string }[] = [],
    slugger = new GithubSlugger();
  const walk = (node: PreviewNode) => {
    if (node.type === "heading") {
      const title = textOf(node);
      headings.push({ title, slug: slugger.slug(title) });
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return { metadata, metadataError, headings };
}

export type NoteLink =
  | { kind: "external"; href: string }
  | { kind: "blocked"; reason: string }
  | { kind: "missing"; path: string }
  | { kind: "attachment"; path: string }
  | { kind: "note"; path: string; heading?: string };
export type Backlink = { source: string; heading?: string };
export function resolveNoteLink(
  target: string,
  owner: string,
  files: Record<string, string>,
): NoteLink {
  if (!target || /[\x00-\x20]/.test(target.replace(/ /g, "")))
    return { kind: "blocked", reason: "无效链接" };
  if (/^(https?:|mailto:)/i.test(target)) {
    try {
      const url = new URL(target);
      if (url.protocol !== "mailto:" && !url.hostname) throw new Error();
      return { kind: "external", href: url.href };
    } catch {
      return { kind: "blocked", reason: "无效外部地址" };
    }
  }
  if (/^[a-z][a-z\d+.-]*:|^\/|\\/i.test(target))
    return { kind: "blocked", reason: "不支持的协议或绝对路径" };
  const split = target.indexOf("#"),
    pathPart = (split < 0 ? target : target.slice(0, split)).split("?")[0];
  let decoded: string, heading: string | undefined;
  try {
    decoded = decodeURIComponent(pathPart);
    heading =
      split < 0 ? undefined : decodeURIComponent(target.slice(split + 1));
  } catch {
    return { kind: "blocked", reason: "链接编码无效" };
  }
  if (heading?.startsWith("^"))
    return { kind: "blocked", reason: "不支持 block-id 定位，请使用标题" };
  let resolved = owner;
  if (decoded) {
    const parts = /^(raw|derived)\//.test(decoded)
      ? []
      : owner.split("/").slice(0, -1);
    for (const part of decoded.split("/")) {
      if (part === "..") {
        if (!parts.length) return { kind: "blocked", reason: "路径越出知识库" };
        parts.pop();
      } else if (part !== ".") parts.push(part);
    }
    resolved = parts.join("/");
  }
  if (!pathSchema.safeParse(resolved).success)
    return { kind: "blocked", reason: "链接不在支持的知识库路径中" };
  const actual = [resolved, resolved + ".md", resolved + ".opml"].find((p) =>
    Object.hasOwn(files, p),
  );
  if (!actual) return { kind: "missing", path: resolved };
  if (!/\.(md|opml)$/.test(actual)) return { kind: "attachment", path: actual };
  return { kind: "note", path: actual, heading };
}

/** Find Markdown sources that resolve to the same portable target path. */
export function backlinksFor(
  target: string,
  files: Record<string, string>,
): Backlink[] {
  const found = new Map<string, Backlink>();
  for (const [source, markdown] of Object.entries(files)) {
    if (!source.endsWith(".md")) continue;
    try {
      const walk = (node: PreviewNode) => {
        const raw =
          node.type === "wikiLink" || node.type === "embed"
            ? node.value
            : node.type === "link"
              ? node.url
              : undefined;
        if (raw) {
          const resolved = resolveNoteLink(raw, source, files);
          if (resolved.kind === "note" && resolved.path === target)
            found.set(source, { source, heading: resolved.heading });
        }
        node.children?.forEach(walk);
      };
      walk(parsePreview(markdown));
    } catch {
      // A malformed source should never disable browsing other readable notes.
    }
  }
  return [...found.values()].sort((a, b) => a.source.localeCompare(b.source));
}

/** Keep community parsing, adapt its output to our path policy and text-only risk scope. */
export function remarkPreviewPolicy() {
  return (root: Root) => {
    const slugger = new GithubSlugger();
    limitMathNodes(root as unknown as PreviewNode);
    const walk = (node: PreviewNode) => {
      if (node.type === "highlight") node.data = { hName: "mark" };
      if (node.type === "wikiLink" || node.type === "embed") {
        const embedded = node.type === "embed";
        const value = node.value ?? "",
          label = node.data?.alias ?? value;
        // Never allow the plugin's automatic iframe/video/src elements to load resources.
        node.data = {
          alias: label,
          hName: embedded ? "span" : "a",
          hProperties: embedded ? {} : { href: value },
          hChildren: [
            {
              type: "text",
              value: embedded ? `[嵌入：${value} · 原型暂不加载]` : label,
            },
          ],
        };
      }
      node.children?.forEach(walk);
      if (node.type === "heading")
        node.data = { hProperties: { id: slugger.slug(textOf(node)) } };
    };
    walk(root as unknown as PreviewNode);
  };
}

/** A whole rendered document, including embeds, shares a finite math budget. */
export function limitMathNodes(root: PreviewNode) {
  let count = 0,
    length = 0;
  const walk = (node: PreviewNode) => {
    if (
      node.type === "math" ||
      node.type === "inlineMath" ||
      (node.type === "code" && node.lang === "math")
    ) {
      count++;
      length += node.value?.length ?? 0;
      if ((node.value?.length ?? 0) > 8192 || count > 200 || length > 65536) {
        node.type = node.type === "inlineMath" ? "inlineCode" : "code";
        node.lang = "text";
        node.value = "[公式超过预览上限，保留源码] " + node.value;
        node.data = undefined;
      }
    }
    node.children?.forEach(walk);
  };
  walk(root);
}
