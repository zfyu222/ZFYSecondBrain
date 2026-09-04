import { parseOpml } from "./formats";
import { noteTitle } from "./note-metadata";

/**
 * A readable title is presentation metadata only: the portable path remains
 * the document identity. Markdown's explicit title wins; map-only documents
 * use their OPML head title without requiring a synthetic Markdown file.
 */
export function documentTitle(files: Record<string, string>, stem: string) {
  const fallback = stem.split("/").pop() ?? "未命名";
  const markdown = files[stem + ".md"];
  if (markdown !== undefined) return noteTitle(markdown) ?? fallback;
  const opml = files[stem + ".opml"];
  return opml === undefined ? fallback : parseOpml(opml).title || fallback;
}
