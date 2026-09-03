import type { Plugin } from "unified";
import type { Root } from "mdast";
import { attachmentSize, type Attachments } from "./attachments";
import {
  limitMathNodes,
  parsePreview,
  resolveNoteLink,
  textOf,
  type PreviewNode,
} from "./preview";

export const embedLimits = {
  depth: 4,
  count: 24,
  characters: 200_000,
} as const;
type Options = {
  owner: string;
  files: Record<string, string>;
  attachments?: Attachments;
};

function limitMedia(root: PreviewNode, options: Options) {
  const definitions = new Map<string, string>();
  const collect = (node: PreviewNode) => {
    if (node.type === "definition" && node.identifier && node.url)
      definitions.set(node.identifier.toUpperCase(), node.url);
    node.children?.forEach(collect);
  };
  collect(root);
  let count = 0,
    bytes = 0;
  const walk = (node: PreviewNode) => {
    const target =
      node.type === "image"
        ? node.url
        : node.type === "imageReference"
          ? definitions.get(node.identifier?.toUpperCase() ?? "")
          : node.type === "embed"
            ? node.value
            : undefined;
    if (target) {
      const origin = node.data?.hProperties?.dataNoteOwner;
      const link = resolveNoteLink(
        target,
        typeof origin === "string" ? origin : options.owner,
        options.files,
      );
      if (link.kind === "attachment" && options.attachments?.[link.path]) {
        count++;
        bytes += attachmentSize(options.attachments[link.path]);
        if (count > 24 || bytes > 8_000_000) {
          node.type = "text";
          node.value = `[附件：${target} · 媒体预览超过上限，请打开原文或下载]`;
          delete node.data;
          delete node.children;
        }
      }
    }
    node.children?.forEach(walk);
  };
  walk(root);
}

/** Select AST siblings, not reprinted Markdown, preserving inline syntax and links. */
export function selectSection(tree: PreviewNode, heading?: string) {
  if (!heading) return { nodes: tree.children ?? [], slug: undefined };
  const candidates: {
    node: PreviewNode;
    siblings: PreviewNode[];
    index: number;
  }[] = [];
  const definitions: PreviewNode[] = [];
  const walk = (parent: PreviewNode) => {
    parent.children?.forEach((node, index) => {
      if (node.type === "heading")
        candidates.push({ node, siblings: parent.children!, index });
      if (node.type === "definition" || node.type === "footnoteDefinition")
        definitions.push(node);
      walk(node);
    });
  };
  walk(tree);
  const found =
    candidates.find(({ node }) => textOf(node) === heading) ??
    candidates.find(({ node }) => node.data?.hProperties?.id === heading);
  if (!found) throw new Error("标题未找到：" + heading);
  let end = found.index + 1;
  while (end < found.siblings.length) {
    const next = found.siblings[end];
    if (next.type === "heading" && (next.depth ?? 6) <= (found.node.depth ?? 6))
      break;
    end++;
  }
  const selected = found.siblings.slice(found.index, end);
  // Definitions remain document-scoped even when their declaration is outside the section.
  const contained = new Set<PreviewNode>();
  const collect = (node: PreviewNode) => {
    contained.add(node);
    node.children?.forEach(collect);
  };
  selected.forEach(collect);
  return {
    nodes: [...selected, ...definitions.filter((node) => !contained.has(node))],
    slug: String(found.node.data?.hProperties?.id ?? ""),
  };
}

function markOrigin(node: PreviewNode, owner: string, prefix: string) {
  if (
    ["link", "linkReference", "wikiLink", "image", "imageReference"].includes(
      node.type,
    )
  ) {
    node.data ??= {};
    node.data.hProperties = { ...node.data.hProperties, dataNoteOwner: owner };
  }
  if (node.type === "heading" && node.data?.hProperties?.id)
    node.data.hProperties.id = prefix + node.data.hProperties.id;
  if (
    (node.type === "footnoteDefinition" || node.type === "footnoteReference") &&
    node.identifier
  )
    node.identifier = prefix + node.identifier;
  // Reference definitions must not collide with those of the host or another embed.
  if (
    ["definition", "linkReference", "imageReference"].includes(node.type) &&
    node.identifier
  )
    node.identifier = prefix + node.identifier;
  node.children?.forEach((child) => markOrigin(child, owner, prefix));
}

export const remarkDocumentEmbeds: Plugin<[Options], Root> =
  (options) => (root) => {
    let count = 0,
      characters = 0;
    const failure = (target: string, reason: string): PreviewNode => ({
      type: "paragraph",
      data: { hProperties: { className: ["embed-unavailable"] } },
      children: [{ type: "text", value: `[嵌入：${target} · ${reason}]` }],
    });
    const expand = (
      nodes: PreviewNode[],
      owner: string,
      chain: string[],
      depth: number,
    ): PreviewNode[] =>
      nodes.map((node) => {
        const meaningful = node.children?.filter(
          (child) => child.type !== "text" || child.value?.trim(),
        );
        if (
          node.type === "paragraph" &&
          meaningful?.length === 1 &&
          meaningful[0].type === "embed"
        ) {
          const embed = meaningful[0],
            target = embed.value ?? "";
          if (depth >= embedLimits.depth)
            return failure(target, "嵌套过深，请打开原文");
          if (count >= embedLimits.count)
            return failure(target, "嵌入数量超过预览上限，请打开原文");
          const link = resolveNoteLink(target, owner, options.files);
          if (link.kind === "attachment") {
            embed.data = {
              hName: "img",
              hProperties: {
                src: target,
                alt: embed.data?.alias ?? target,
                dataNoteOwner: owner,
              },
            };
            return node;
          }
          if (link.kind !== "note" || !link.path.endsWith(".md"))
            return failure(
              target,
              link.kind === "missing" ? "文档不存在" : "暂不加载此类嵌入",
            );
          const source = options.files[link.path];
          if (characters + source.length > embedLimits.characters)
            return failure(target, "嵌入内容超过预览上限，请打开原文");
          count++;
          characters += source.length;
          try {
            const selected = selectSection(parsePreview(source), link.heading);
            const key = `${link.path}#${selected.slug ?? ""}`;
            if (chain.includes(key)) return failure(target, "循环引用已停止");
            // Colons cannot occur in ordinary GitHub heading slugs. These identifiers
            // are render-only, never persisted in raw Markdown or used as note links.
            const prefix = `embed:${count}:`;
            selected.nodes.forEach((child) =>
              markOrigin(child, link.path, prefix),
            );
            const content = expand(
              selected.nodes,
              link.path,
              [...chain, key],
              depth + 1,
            );
            return {
              type: "blockquote",
              data: {
                hName: "section",
                hProperties: {
                  className: ["note-embed"],
                  dataEmbedPath: link.path,
                },
              },
              children: [
                {
                  type: "paragraph",
                  data: {
                    hName: "div",
                    hProperties: { className: ["embed-heading"] },
                  },
                  children: [
                    {
                      type: "link",
                      url:
                        encodeURI(link.path).replaceAll("#", "%23") +
                        (selected.slug
                          ? "#" + encodeURIComponent(selected.slug)
                          : ""),
                      children: [
                        {
                          type: "text",
                          value: "来源：" + (embed.data?.alias ?? target),
                        },
                      ],
                    },
                  ],
                },
                ...content.filter((child) => child.type !== "yaml"),
              ],
            };
          } catch (error) {
            return failure(target, String(error));
          }
        }
        if (node.type === "embed") {
          if (
            resolveNoteLink(node.value ?? "", owner, options.files).kind ===
            "attachment"
          ) {
            node.data = {
              hName: "img",
              hProperties: {
                src: node.value,
                alt: node.data?.alias ?? node.value,
                dataNoteOwner: owner,
              },
            };
            return node;
          }
          // Inline embeds remain links: inserting a block document inside a sentence
          // would create invalid paragraph markup and obscure the sentence itself.
          node.data = {
            ...node.data,
            hName: "a",
            hProperties: { href: node.value ?? "", dataNoteOwner: owner },
            hChildren: [
              {
                type: "text",
                value: `[嵌入：${node.data?.alias ?? node.value} · 打开原文]`,
              },
            ],
          };
        }
        if (node.children)
          node.children = expand(node.children, owner, chain, depth);
        return node;
      });
    const tree = root as unknown as PreviewNode;
    tree.children = expand(
      tree.children ?? [],
      options.owner,
      [`${options.owner}#`],
      0,
    );
    limitMathNodes(tree);
    limitMedia(tree, options);
  };
