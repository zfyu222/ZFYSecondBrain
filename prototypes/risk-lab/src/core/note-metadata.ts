import { safeYaml } from "./formats";

type Metadata = Record<string, unknown>;
const frontMatter =
  /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n(?:---|\.\.\.)(?:\r?\n|$))/;

function readFrontMatter(source: string) {
  const match = frontMatter.exec(source);
  if (!match) {
    if (/^\uFEFF?---\r?\n/.test(source))
      throw new Error("Front Matter 未闭合，元数据未修改");
    return null;
  }
  const metadata = safeYaml(match[2]);
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  )
    throw new Error("Front Matter 应为键值对象，元数据未修改");
  const favorite = (metadata as Metadata).favorite;
  if (favorite !== undefined && typeof favorite !== "boolean")
    throw new Error("favorite 必须为 true 或 false，元数据未修改");
  return { match, metadata: metadata as Metadata };
}

export function isFavorite(source: string) {
  return readFrontMatter(source)?.metadata.favorite === true;
}

/** Change only the top-level portable `favorite` field, preserving source line endings. */
export function setFavorite(source: string, favorite: boolean) {
  const front = readFrontMatter(source);
  if (!front) {
    const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = bom ? source.slice(1) : source;
    return `${bom}---\nfavorite: ${favorite}\n---\n${body}`;
  }
  const [whole, opening, body, closing] = front.match;
  const newline = opening.includes("\r\n") ? "\r\n" : "\n";
  const favoriteLine = /^(favorite:\s*)(?:true|false)(\s*(?:#.*)?)(\r?\n|$)/m;
  const updatedBody = favoriteLine.test(body)
    ? body.replace(
        favoriteLine,
        (_line, prefix: string, suffix: string, lineEnd: string) =>
          `${prefix}${favorite}${suffix}${lineEnd}`,
      )
    : `favorite: ${favorite}${newline}` + body;
  return source.replace(whole, opening + updatedBody + closing);
}
