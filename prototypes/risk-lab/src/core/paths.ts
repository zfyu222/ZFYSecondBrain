import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { decodeString } from "micromark-util-decode-string";
import { pathSchema } from "./contracts";
import {
  parseOpml,
  flatten,
  serializeOpml,
  safeYaml,
  relationsSchema,
} from "./formats";
import { parseDocument, isMap, isSeq, isScalar } from "yaml";

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
  const split = target.search(/[?#]/);
  const path = split < 0 ? target : target.slice(0, split),
    anchor = split < 0 ? "" : target.slice(split);
  if (!path) return target;
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
  return (
    (path.includes("%") ? encodeURI(result) : result).replace(/[?#]/g, (c) =>
      encodeURIComponent(c),
    ) + anchor
  );
}

export function rewriteMarkdown(
  text: string,
  oldOwner: string,
  newOwner: string,
  moves: Map<string, string>,
  processFrontMatter = true,
): string {
  const edits: { start: number; end: number; value: string }[] = [];
  const protectedRanges: [number, number][] = [];
  const rewrite = (target: string) =>
    rewriteTarget(target, oldOwner, newOwner, moves);
  let input = text;
  const front = processFrontMatter
    ? /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n(?:---|\.\.\.)(?:\r?\n|$))/.exec(text)
    : null;
  if (processFrontMatter && /^\uFEFF?---\r?\n/.test(text) && !front)
    throw new Error("Front Matter 未闭合，移动已取消");
  if (front) {
    safeYaml(front[2]);
    const doc = parseDocument(front[2]);
    let changed = false;
    const pathKeys = new Set([
      "url",
      "cover",
      "image",
      "video",
      "audio",
      "attachment",
      "links",
      "soft_links",
      "references",
    ]);
    function visit(node: unknown, key = "") {
      if (isMap(node))
        for (const pair of node.items)
          visit(pair.value, isScalar(pair.key) ? String(pair.key.value) : "");
      else if (isSeq(node)) for (const item of node.items) visit(item, key);
      else if (isScalar(node) && typeof node.value === "string") {
        const original = node.value;
        let value = rewriteMarkdown(original, oldOwner, newOwner, moves, false);
        if (
          pathKeys.has(key) &&
          value === original &&
          !/\[\[|\]\(/.test(original)
        )
          value = rewrite(original);
        else if (
          /^(raw|derived)\//.test(original) &&
          rewrite(original) !== original &&
          value === original
        )
          throw new Error(
            "Front Matter 未知字段含路径，请先明确字段类型：" + key,
          );
        if (value !== original) {
          node.value = value;
          changed = true;
        }
      }
    }
    visit(doc.contents);
    if (changed) {
      const newline = front[1].includes("\r\n") ? "\r\n" : "\n";
      const yaml = String(doc)
        .replace(/\r?\n$/, "")
        .replace(/\r?\n/g, newline);
      edits.push({
        start: 0,
        end: front[0].length,
        value: front[1] + yaml + front[3],
      });
    }
    protectedRanges.push([0, front[0].length]);
    input = front[0].replace(/[^\r\n]/g, " ") + text.slice(front[0].length);
  }
  const events = postprocess(
    parse({ extensions: [gfm(), math()] })
      .document()
      .write(preprocess()(input, undefined, true)),
  );
  for (const [event, token] of events) {
    if (event !== "enter") continue;
    const start = token.start.offset,
      end = token.end.offset;
    if (
      [
        "codeFenced",
        "codeIndented",
        "codeText",
        "mathFlow",
        "mathText",
        "htmlFlow",
        "htmlText",
        "resourceDestination",
        "definitionDestination",
        "resourceTitle",
        "definitionTitle",
      ].includes(token.type)
    )
      protectedRanges.push([start, end]);
    if (token.type === "htmlFlow" || token.type === "htmlText") {
      const raw = text.slice(start, end);
      for (const attr of raw.matchAll(
        /\b(href|src|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      )) {
        const value = decodeString(attr[2] ?? attr[3] ?? attr[4]);
        const targets =
          attr[1].toLowerCase() === "srcset"
            ? value.split(",").map((v) => v.trim().split(/\s+/)[0])
            : [value];
        if (targets.some((v) => rewrite(v) !== v))
          throw new Error("HTML 资源引用尚未支持安全重写，移动已取消");
      }
    }
    if (
      token.type === "resourceDestinationString" ||
      token.type === "definitionDestinationString"
    ) {
      const raw = text.slice(start, end),
        target = decodeString(raw),
        updated = rewrite(target);
      if (updated !== target) {
        // Escape syntax rather than reprinting the entire Markdown document.
        const value = updated
          .replace(/[\s()\\<>]/g, (c) =>
            c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c),
          )
          .replaceAll("&", "&amp;");
        edits.push({ start, end, value });
      }
    }
  }
  for (const match of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
    const start = match.index!,
      opening = start + match[0].indexOf("[[");
    let escapes = 0;
    for (let i = opening - 1; i >= 0 && text[i] === "\\"; i--) escapes++;
    if (
      escapes % 2 ||
      protectedRanges.some(([a, b]) => a <= start && start < b)
    )
      continue;
    const labelSplit = match[1].indexOf("|"),
      target = labelSplit < 0 ? match[1] : match[1].slice(0, labelSplit);
    const updated = rewrite(target);
    if (updated !== target)
      edits.push({
        start: opening + 2,
        end: opening + 2 + target.length,
        value: updated,
      });
  }
  const ordered = edits.sort((a, b) => b.start - a.start);
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i].end > ordered[i - 1].start)
      throw new Error("引用范围重叠，拒绝不确定的重写");
  for (const edit of ordered)
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}
function assertNoUnknownReferences(
  value: unknown,
  owner: string,
  destination: string,
  moves: Map<string, string>,
) {
  if (typeof value === "string") {
    const pathLike =
      /^(?:\.{1,2}\/|raw\/|derived\/)/.test(value) ||
      /\.[a-z0-9]{1,12}(?:[?#].*)?$/i.test(value);
    if (
      (pathLike && rewriteTarget(value, owner, destination, moves) !== value) ||
      rewriteMarkdown(value, owner, destination, moves, false) !== value
    )
      throw new Error("未知结构化字段含引用，需先明确 schema；移动已取消");
  } else if (Array.isArray(value))
    value.forEach((item) =>
      assertNoUnknownReferences(item, owner, destination, moves),
    );
  else if (value && typeof value === "object")
    Object.values(value).forEach((item) =>
      assertNoUnknownReferences(item, owner, destination, moves),
    );
}
/**
 * Moves one Markdown document bundle or every portable file below a directory.
 * The resulting mapping is intentionally explicit so text and binary companions
 * can participate in the same storage transaction.
 */
export function movePath(
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
  const documentMove = from.endsWith(".md") || to.endsWith(".md");
  if (
    from === to ||
    (documentMove && (!from.endsWith(".md") || !to.endsWith(".md")))
  )
    throw new Error("移动入口需要同类且不同的文档或目录路径");
  if (!documentMove && to.startsWith(from + "/"))
    throw new Error("不能将目录移动到自身内部");
  if (requireSource && !documentMove && !Object.keys(files).some((path) => path.startsWith(from + "/")))
    throw new Error("源目录不存在或为空");
  if (requireSource && documentMove && !(from in files))
    throw new Error("源 Markdown 文档不存在");
  const fromStem = documentMove ? from.slice(0, -3) : from,
    toStem = documentMove ? to.slice(0, -3) : to;
  const moves = new Map<string, string>();
  const candidates = [...new Set([...Object.keys(files), ...knownPaths, from])];
  if (!documentMove) {
    moves.set(fromStem, toStem);
    for (const path of candidates) {
      if (!path.startsWith(fromStem + "/")) continue;
      const relativeParts = path.slice(fromStem.length + 1).split("/");
      for (let depth = 1; depth < relativeParts.length; depth++) {
        const directory = fromStem + "/" + relativeParts.slice(0, depth).join("/");
        moves.set(directory, toStem + directory.slice(fromStem.length));
      }
    }
  }
  for (const path of candidates)
    if (
      documentMove
        ? [
            from,
            `${fromStem}.opml`,
            `${fromStem}.relations.yaml`,
            `${fromStem}.note.yaml`,
          ].includes(path) || path.startsWith(`${fromStem}.assets/`)
        : path.startsWith(fromStem + "/")
    )
      moves.set(path, toStem + path.slice(fromStem.length));
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
      const literalHeadFields = new Set([
        "ownerName",
        "ownerEmail",
        "dateCreated",
        "dateModified",
        "expansionState",
        "vertScrollState",
        "windowTop",
        "windowLeft",
        "windowBottom",
        "windowRight",
      ]);
      for (const [name, value] of Object.entries(map.head ?? {})) {
        if (literalHeadFields.has(name)) continue;
        if (["docs", "ownerId"].includes(name)) {
          const rewritten = rewriteTarget(value, path, destination, moves);
          if (rewritten !== value) {
            map.head![name] = rewritten;
            changed = true;
          }
        } else assertNoUnknownReferences(value, path, destination, moves);
      }
      assertNoUnknownReferences(map.attributes, path, destination, moves);
      for (const { node } of flatten(map)) {
        for (const [name, value] of Object.entries(node.attrs))
          if (!["url", "htmlUrl", "xmlUrl"].includes(name))
            assertNoUnknownReferences(value, path, destination, moves);
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
      assertNoUnknownReferences(
        path.endsWith(".json") ? JSON.parse(content) : safeYaml(content),
        path,
        destination,
        moves,
      );
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

/** Backward-compatible name for callers that only move one Markdown document. */
export const moveNote = movePath;
