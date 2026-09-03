import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { pathSchema } from "./contracts";

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
export function rewriteMarkdown(
  text: string,
  oldOwner: string,
  newOwner: string,
  moves: Map<string, string>,
): string {
  const ast = unified().use(remarkParse).use(remarkGfm).parse(text);
  const edits: { start: number; end: number; value: string }[] = [];
  const codeRanges: [number, number][] = [];
  function rewrite(target: string) {
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
) {
  pathSchema.parse(from);
  pathSchema.parse(to);
  if (
    !from.endsWith(".md") ||
    !to.endsWith(".md") ||
    !(from in files) ||
    from === to
  )
    throw new Error("原型移动入口需要两个不同的 Markdown 路径");
  const fromStem = from.slice(0, -3),
    toStem = to.slice(0, -3);
  const moves = new Map<string, string>();
  for (const path of Object.keys(files)) {
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
      .map((p) => p.toLocaleLowerCase("en-US")),
  );
  for (const target of moves.values())
    if (folded.has(target.toLocaleLowerCase("en-US")))
      throw new Error("目标已存在，不能覆盖");
  const result: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const destination = moves.get(path) ?? path;
    if (path.endsWith(".md"))
      result[destination] = rewriteMarkdown(content, path, destination, moves);
    else if (/\.(opml|yaml|json)$/.test(path)) {
      // Until schema-aware rewriting is implemented, refuse rather than corrupt
      // unknown structured references; the UI describes this prototype gate.
      if (
        [...moves.keys()].some(
          (p) =>
            content.includes(p) || content.includes(p.replace(/\.md$/, "")),
        )
      )
        throw new Error("结构化文件含入站路径：原型暂不支持此重写，移动已取消");
      if (path.endsWith(".relations.yaml") && destination !== path) {
        const oldName = `${fromStem.split("/").pop()}.opml`,
          newName = `${toStem.split("/").pop()}.opml`;
        if (oldName !== newName)
          throw new Error(
            "带关系文件的重命名尚待 schema 重写；可保持文件名移动目录",
          );
      }
      result[destination] = content;
    } else result[destination] = content;
  }
  return { files: result, moves: Object.fromEntries(moves) };
}
