import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { pathSchema } from "./contracts";
import {
  parseOpml,
  flatten,
  serializeOpml,
  safeYaml,
  relationsSchema,
} from "./formats";
import { parseDocument } from "yaml";

function resolve(from: string, target: string): string {
  const parts =
    target.startsWith("raw/") || target.startsWith("derived/")
      ? []
      : from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}
function relative(from: string, to: string): string {
  const a = from.split("/").slice(0, -1),
    b = to.split("/");
  while (a.length && b.length && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  return [...a.map(() => ".."), ...b].join("/");
}
export function rewriteTarget(
  target: string,
  oldOwner: string,
  newOwner: string,
  moves: Map<string, string>,
) {
  if (/^[a-z][a-z\d+.-]*:|^\/|^#/i.test(target)) return target;
  const split = target.indexOf("#");
  const path = split < 0 ? target : target.slice(0, split),
    anchor = split < 0 ? "" : target.slice(split);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return target;
  }
  const resolved = resolve(oldOwner, decoded);
  const oldActual = moves.has(resolved)
    ? resolved
    : moves.has(`${resolved}.md`)
      ? `${resolved}.md`
      : undefined;
  const actual = oldActual ? moves.get(oldActual)! : resolved;
  const withoutExtension =
    oldActual?.endsWith(".md") && !decoded.endsWith(".md");
  const destination = withoutExtension ? actual.slice(0, -3) : actual;
  const result =
    decoded.startsWith("raw/") || decoded.startsWith("derived/")
      ? destination
      : relative(newOwner, destination);
  if (!oldActual && oldOwner === newOwner) return target;
  return (path.includes("%") ? encodeURI(result) : result) + anchor;
}

export function rewriteMarkdown(
  text: string,
  oldOwner: string,
  newOwner: string,
  moves: Map<string, string>,
): string {
  const ast = unified().use(remarkParse).use(remarkGfm).parse(text);
  const edits: { start: number; end: number; value: string }[] = [];
  const codeRanges: [number, number][] = [];
  const rewrite = (target: string) =>
    rewriteTarget(target, oldOwner, newOwner, moves);
  function walk(node: any) {
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (
      node.type === "code" ||
      node.type === "inlineCode" ||
      node.type === "html"
    ) {
      codeRanges.push([start, end]);
      return;
    }
    if (
      ["link", "image", "definition"].includes(node.type) &&
      typeof node.url === "string"
    ) {
      const updated = rewrite(node.url);
      if (updated !== node.url) {
        const raw = text.slice(start, end);
        // Only rewrite the parsed destination, never matching arbitrary prose.
        const destinationStart =
          node.type === "definition"
            ? raw.indexOf(":") + 1
            : raw.lastIndexOf("](") + 2;
        const at = raw.indexOf(node.url, destinationStart);
        if (at < destinationStart || destinationStart < 1)
          throw new Error("此 Markdown 链接写法暂不支持安全重写");
        edits.push({
          start: start + at,
          end: start + at + node.url.length,
          value: updated,
        });
      }
    }
    node.children?.forEach(walk);
  }
  walk(ast);
  const wiki = /!?\[\[([^\]\n]+)\]\]/g;
  for (const match of text.matchAll(wiki)) {
    const start = match.index!;
    if (codeRanges.some(([a, b]) => a <= start && start < b)) continue;
    const labelSplit = match[1].indexOf("|");
    const target = labelSplit < 0 ? match[1] : match[1].slice(0, labelSplit);
    const updated = rewrite(target);
    if (updated !== target) {
      const at = start + match[0].indexOf("[[") + 2;
      edits.push({ start: at, end: at + target.length, value: updated });
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}
export function moveNote(
  files: Record<string, string>,
  from: string,
  to: string,
  requireSource = true,
  knownPaths: string[] = [],
) {
  pathSchema.parse(from);
  pathSchema.parse(to);
  if (
    from !== to &&
    from.normalize("NFC").toLocaleLowerCase("en-US") ===
      to.normalize("NFC").toLocaleLowerCase("en-US")
  )
    throw new Error("暂不支持仅大小写或 Unicode 等价的重命名");
  if (
    !from.endsWith(".md") ||
    !to.endsWith(".md") ||
    (requireSource && !(from in files)) ||
    from === to
  )
    throw new Error("原型移动入口需要两个不同的 Markdown 路径");
  const fromStem = from.slice(0, -3),
    toStem = to.slice(0, -3);
  const moves = new Map<string, string>();
  for (const path of [
    ...Object.keys(files),
    ...knownPaths,
    from,
    `${fromStem}.opml`,
    `${fromStem}.relations.yaml`,
    `${fromStem}.note.yaml`,
  ]) {
    if (
      [
        from,
        `${fromStem}.opml`,
        `${fromStem}.relations.yaml`,
        `${fromStem}.note.yaml`,
      ].includes(path) ||
      path.startsWith(`${fromStem}.assets/`)
    )
      moves.set(path, toStem + path.slice(fromStem.length));
  }
  const folded = new Set(
    Object.keys(files)
      .filter((p) => !moves.has(p))
      .map((p) => p.normalize("NFC").toLocaleLowerCase("en-US")),
  );
  for (const target of moves.values())
    if (folded.has(target.normalize("NFC").toLocaleLowerCase("en-US")))
      throw new Error("目标已存在，不能覆盖");
  const result: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const destination = moves.get(path) ?? path;
    if (path.endsWith(".md"))
      result[destination] = rewriteMarkdown(content, path, destination, moves);
    else if (path.endsWith(".opml")) {
      const map = parseOpml(content);
      let changed = false;
      for (const { node } of flatten(map)) {
        const body = rewriteMarkdown(node.body, path, destination, moves);
        if (body !== node.body) {
          node.body = body;
          changed = true;
        }
        for (const attr of ["url", "htmlUrl", "xmlUrl"]) {
          if (node.attrs[attr]) {
            const value = rewriteTarget(
              node.attrs[attr],
              path,
              destination,
              moves,
            );
            if (value !== node.attrs[attr]) {
              node.attrs[attr] = value;
              changed = true;
            }
          }
        }
      }
      result[destination] = changed ? serializeOpml(map) : content;
    } else if (path.endsWith(".relations.yaml") && content.trim()) {
      const data = relationsSchema.parse(safeYaml(content));
      const target = rewriteTarget(data.map, path, destination, moves);
      if (target !== data.map) {
        const doc = parseDocument(content);
        doc.set("map", target.startsWith(".") ? target : "./" + target);
        result[destination] = String(doc);
      } else result[destination] = content;
    } else if (/\.(yaml|json)$/.test(path)) {
      if (
        [...moves.keys()].some(
          (p) =>
            content.includes(p) || content.includes(p.replace(/\.md$/, "")),
        )
      )
        throw new Error("未知结构化文件含入站路径，移动已取消");
      result[destination] = content;
    } else result[destination] = content;
  }
  return { files: result, moves: Object.fromEntries(moves) };
}
