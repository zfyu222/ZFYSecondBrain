import { flatten, parseOpml } from "./formats";
import { backlinksFor, parsePreview, resolveNoteLink, type PreviewNode } from "./preview";

/**
 * Returns portable, same-vault note neighbors only.  The retrieval layer never
 * follows external URLs or treats an unresolved link as knowledge evidence.
 */
export function linkedNeighbors(path: string, files: Record<string, string>) {
  const related = new Set(backlinksFor(path, files).map((link) => link.source));
  const source = files[path];
  if (source === undefined) return [...related].sort();
  try {
    if (path.endsWith(".opml")) {
      for (const { node } of flatten(parseOpml(source))) {
        const raw = node.attrs.url;
        if (!raw) continue;
        const resolved = resolveNoteLink(raw, path, files);
        if (resolved.kind === "note") related.add(resolved.path);
      }
    } else if (path.endsWith(".md")) {
      const walk = (node: PreviewNode) => {
        if (node.type === "wikiLink" || node.type === "embed") {
          const resolved = resolveNoteLink(node.value ?? "", path, files);
          if (resolved.kind === "note") related.add(resolved.path);
        }
        node.children?.forEach(walk);
      };
      walk(parsePreview(source));
    }
  } catch {
    // A malformed optional document must not make a read-only search fail.
  }
  related.delete(path);
  return [...related].sort();
}
