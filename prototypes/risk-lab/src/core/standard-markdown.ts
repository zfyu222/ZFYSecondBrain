import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

type Edit = { start: number; end: number; value: string };

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
  const a = from.split("/").slice(0, -1);
  const b = to.split("/");
  while (a.length && b.length && a[0] === b[0]) {
    a.shift();
    b.shift();
  }
  return [...a.map(() => ".."), ...b].join("/");
}

function destination(owner: string, target: string): string {
  const hash = target.indexOf("#");
  const path = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? "" : target.slice(hash);
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path)) return target;
  const resolved = resolve(owner, path);
  const file = /\.[^/]+$/.test(resolved) ? resolved : `${resolved}.md`;
  return `${relative(owner, file)}${fragment}`
    .replace(/ /g, "%20")
    .replace(/\)/g, "%29");
}

function label(value: string): string {
  return value.replace(/[\[\]]/g, "\\$&");
}

function fallbackLabel(target: string): string {
  const path = target.split("#", 1)[0];
  return path.split("/").pop()?.replace(/\.md$/i, "") || target;
}

/** Converts tested Wiki links to portable CommonMark without reformatting text. */
export function standardMarkdown(text: string, owner: string): string {
  const protectedRanges: [number, number][] = [];
  const events = postprocess(
    parse({ extensions: [gfm(), math()] })
      .document()
      .write(preprocess()(text, undefined, true)),
  );
  for (const [event, token] of events) {
    if (event !== "enter") continue;
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
      protectedRanges.push([token.start.offset, token.end.offset]);
  }
  const edits: Edit[] = [];
  for (const match of text.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const start = match.index!;
    let escapes = 0;
    for (let i = start - 1; i >= 0 && text[i] === "\\"; i--) escapes++;
    if (escapes % 2 || protectedRanges.some(([a, b]) => a <= start && start < b))
      continue;
    const bar = match[2].indexOf("|");
    const target = bar < 0 ? match[2] : match[2].slice(0, bar);
    const alias = bar < 0 ? fallbackLabel(target) : match[2].slice(bar + 1);
    const url = destination(owner, target);
    const isImage = /\.(?:apng|avif|gif|jpe?g|png|svg|webp)(?:#.*)?$/i.test(target);
    edits.push({
      start,
      end: start + match[0].length,
      value: `${match[1] === "!" && isImage ? "!" : ""}[${label(alias)}](${url})`,
    });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}
