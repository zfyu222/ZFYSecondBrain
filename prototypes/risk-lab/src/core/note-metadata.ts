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

function validTag(value: string) {
  const tag = value.trim();
  if (!tag || tag.length > 80 || /[\x00-\x1f\[\]#,]/.test(tag))
    throw new Error("标签必须是长度不超过 80 的普通文本");
  return tag;
}

/** OFM-compatible tags may be one string or a string list; never infer prose tags. */
export function noteTags(source: string) {
  const value = readFrontMatter(source)?.metadata.tags;
  if (value === undefined) return [];
  const tags = typeof value === "string" ? [value] : value;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))
    throw new Error("tags 必须是文本或文本列表");
  const normalized = tags.map(validTag);
  if (
    new Set(normalized.map((tag) => tag.toLocaleLowerCase("en-US"))).size !==
    normalized.length
  )
    throw new Error("tags 不能包含重复标签");
  return normalized;
}

/** Extra readable directory entrances for one real note; never an OS symlink. */
export function softLinks(source: string) {
  const value = readFrontMatter(source)?.metadata.soft_links;
  if (value === undefined) return [];
  const links = typeof value === "string" ? [value] : value;
  if (!Array.isArray(links) || links.some((link) => typeof link !== "string"))
    throw new Error("soft_links 必须是文本或文本列表");
  const normalized = links.map(validSoftLink);
  if (new Set(normalized).size !== normalized.length)
    throw new Error("soft_links 不能包含重复入口");
  return normalized;
}

export function setSoftLinks(source: string, links: string[]) {
  const normalized = links.map(validSoftLink);
  if (new Set(normalized).size !== normalized.length)
    throw new Error("soft_links 不能包含重复入口");
  const front = readFrontMatter(source);
  const line = `soft_links: ${formatTags(normalized)}`;
  if (!front) {
    const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
    return `${bom}---\n${line}\n---\n${bom ? source.slice(1) : source}`;
  }
  const [whole, opening, body, closing] = front.match;
  if (/^soft_links:\s*(?:#.*)?\r?\n[ \t]+-\s/m.test(body))
    throw new Error("块状 soft_links 请在 Markdown 中手工整理，元数据未修改");
  const softLinkLine = /^(soft_links:\s*)[^\r\n#]*?(\s*(?:#.*)?)(\r?\n|$)/m;
  const updatedBody = softLinkLine.test(body)
    ? body.replace(
        softLinkLine,
        (_line, _prefix: string, suffix: string, lineEnd: string) =>
          `${line}${suffix}${lineEnd}`,
      )
    : `${line}${opening.includes("\r\n") ? "\r\n" : "\n"}` + body;
  return source.replace(whole, opening + updatedBody + closing);
}

function validSoftLink(link: string) {
  const value = link.trim().replace(/\/$/, "");
  if (
    !/^(raw\/(Inbox|Projects|Areas|Archive))\/.+/.test(value) ||
    /[\\\x00-\x1f<>:"|?*]/.test(value) ||
    value.split("/").some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part),
    )
  )
    throw new Error("软链接入口必须是知识库内的可读目录路径");
  return value;
}

function formatTags(tags: string[]) {
  return `[${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`;
}

/** Write a conservative inline OFM list; block-style fields are left untouched. */
export function setNoteTags(source: string, tags: string[]) {
  const normalized = tags.map(validTag);
  if (
    new Set(normalized.map((tag) => tag.toLocaleLowerCase("en-US"))).size !==
    normalized.length
  )
    throw new Error("tags 不能包含重复标签");
  const front = readFrontMatter(source);
  const line = `tags: ${formatTags(normalized)}`;
  if (!front) {
    const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
    return `${bom}---\ntags: ${formatTags(normalized)}\n---\n${bom ? source.slice(1) : source}`;
  }
  const [whole, opening, body, closing] = front.match;
  if (/^tags:\s*(?:#.*)?\r?\n[ \t]+-\s/m.test(body))
    throw new Error("块状 tags 请在 Markdown 中手工整理，元数据未修改");
  const tagLine = /^(tags:\s*)[^\r\n#]*?(\s*(?:#.*)?)(\r?\n|$)/m;
  const updatedBody = tagLine.test(body)
    ? body.replace(
        tagLine,
        (_line, _prefix: string, suffix: string, lineEnd: string) =>
          `${line}${suffix}${lineEnd}`,
      )
    : `${line}${opening.includes("\r\n") ? "\r\n" : "\n"}` + body;
  return source.replace(whole, opening + updatedBody + closing);
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
