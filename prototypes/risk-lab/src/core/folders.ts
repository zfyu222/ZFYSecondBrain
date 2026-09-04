import { softLinks } from "./note-metadata";

export type FolderNode = { path: string; name: string; children: FolderNode[] };

/** A virtual soft-link entrance participates in folder browsing without copying a note. */
export function appearsInFolder(
  stem: string,
  markdown: string | undefined,
  folder: string,
) {
  if (!folder || stem.startsWith(folder + "/")) return true;
  if (!markdown) return false;
  try {
    return softLinks(markdown).some(
      (link) => link === folder || link.startsWith(folder + "/"),
    );
  } catch {
    return false;
  }
}

/**
 * Build a readable directory tree from portable note stems and virtual entrances.
 * A soft link names a directory (rather than a copied note), so all of its path
 * segments deliberately remain selectable even when no physical file lives there.
 */
export function folderTree(stems: string[], virtualFolders: string[] = []) {
  const roots: FolderNode[] = [];
  const add = (parts: string[]) => {
    let level = roots;
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join("/");
      let node = level.find((item) => item.path === path);
      if (!node) {
        node = { path, name: parts[index], children: [] };
        level.push(node);
      }
      level = node.children;
    }
  };
  for (const stem of stems) {
    add(stem.split("/").slice(0, -1));
  }
  for (const folder of virtualFolders) {
    add(folder.split("/"));
  }
  const sort = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}
