import { noteTags } from "./note-metadata";

/**
 * A compact local-query grammar: ordinary terms match readable path/body text;
 * `#tag` terms are conjunctive portable OFM tag filters. Archive is opt-in
 * only while searching, so browsing remains able to show archived material.
 */
export function matchesNoteSearch(
  stem: string,
  markdown: string,
  query: string,
  includeArchive: boolean,
) {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  if (!includeArchive && stem.startsWith("raw/Archive/")) return false;
  const requestedTags = tokens
    .filter((token) => token.startsWith("#") && token.length > 1)
    .map((token) => token.slice(1).toLocaleLowerCase("en-US"));
  const textTerms = tokens.filter(
    (token) => !token.startsWith("#") || token.length === 1,
  );
  try {
    const tags = new Set(
      noteTags(markdown).map((tag) => tag.toLocaleLowerCase("en-US")),
    );
    if (!requestedTags.every((tag) => tags.has(tag))) return false;
  } catch {
    return false;
  }
  const searchable = `${stem}\n${markdown}`.toLocaleLowerCase("en-US");
  return textTerms.every((term) =>
    searchable.includes(term.toLocaleLowerCase("en-US")),
  );
}
