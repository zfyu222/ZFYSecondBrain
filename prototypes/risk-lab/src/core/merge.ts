import { diff3Merge } from "node-diff3";
import { validateFiles } from "./contracts";

type Files = Record<string, string>;
type Versions = {
  base: string | null;
  local: string | null;
  remote: string | null;
};
export type TextPart = { text: string } | ({ key: string } & Versions);
export type Conflict = { path: string } & Versions &
  (
    | { kind: "file" }
    | { kind: "text"; parts: TextPart[] }
    | {
        kind: "graph";
        paths: string[];
        baseFiles: Files;
        localFiles: Files;
        remoteFiles: Files;
      }
  );
export type MergeResult = { files: Files; conflicts: Conflict[] };
export type Choices = Record<string, "local" | "remote">;

const splitLines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const versions = (
  path: string,
  base: Files,
  local: Files,
  remote: Files,
): Versions => ({
  base: base[path] ?? null,
  local: local[path] ?? null,
  remote: remote[path] ?? null,
});
const pick = (files: Files, paths: string[]) =>
  Object.fromEntries(paths.filter((p) => p in files).map((p) => [p, files[p]]));
const same = (a: Files, b: Files, paths: string[]) =>
  paths.every((p) => a[p] === b[p]);

// OPML node paths and accompanying relation endpoints are one consistency boundary.
function mergeGraph(
  path: string,
  base: Files,
  local: Files,
  remote: Files,
): MergeResult {
  const paths = [path, path.replace(/\.opml$/, ".relations.yaml")];
  const b = pick(base, paths),
    l = pick(local, paths),
    r = pick(remote, paths);
  if (same(l, r, paths)) return { files: l, conflicts: [] };
  if (same(l, b, paths)) return { files: r, conflicts: [] };
  if (same(r, b, paths)) return { files: l, conflicts: [] };
  // Separate component changes may commute, but only if endpoints still exist.
  // Never fuzzy-match renamed nodes or line-merge structured XML/YAML.
  const candidate: Files = {};
  let overlap = false;
  for (const p of paths) {
    if (l[p] !== r[p] && l[p] !== b[p] && r[p] !== b[p]) {
      overlap = true;
      break;
    }
    const value = l[p] === b[p] ? r[p] : l[p];
    if (value !== undefined) candidate[p] = value;
  }
  if (!overlap) {
    try {
      validateFiles(candidate);
      return { files: candidate, conflicts: [] };
    } catch {
      /* Incompatible components require one coherent branch. */
    }
  }
  return {
    files: {},
    conflicts: [
      {
        kind: "graph",
        path,
        paths,
        ...versions(path, base, local, remote),
        baseFiles: b,
        localFiles: l,
        remoteFiles: r,
      },
    ],
  };
}

export function mergeFiles(
  base: Files,
  local: Files,
  remote: Files,
): MergeResult {
  const files: Files = {},
    conflicts: Conflict[] = [];
  const all = [
    ...new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ]),
  ].sort();
  const handled = new Set<string>();
  for (const path of all) {
    if (handled.has(path)) continue;
    if (path.endsWith(".opml") || path.endsWith(".relations.yaml")) {
      const opml = path.replace(/\.relations\.yaml$/, ".opml");
      handled.add(opml);
      handled.add(opml.replace(/\.opml$/, ".relations.yaml"));
      const group = mergeGraph(opml, base, local, remote);
      Object.assign(files, group.files);
      conflicts.push(...group.conflicts);
      continue;
    }
    const b = base[path],
      l = local[path],
      r = remote[path];
    let value: string | undefined;
    if (l === r) value = l;
    else if (l === b) value = r;
    else if (r === b) value = l;
    else if (
      b !== undefined &&
      l !== undefined &&
      r !== undefined &&
      path.endsWith(".md")
    ) {
      const parts: TextPart[] = diff3Merge(
        splitLines(l),
        splitLines(b),
        splitLines(r),
      ).map((part, index) => {
        if (part.ok) return { text: part.ok.join("") };
        const c = part.conflict!;
        return {
          key: JSON.stringify([path, "hunk", index]),
          base: c.o.join(""),
          local: c.a.join(""),
          remote: c.b.join(""),
        };
      });
      if (parts.every((p) => "text" in p))
        value = parts.map((p) => (p as { text: string }).text).join("");
      else
        conflicts.push({
          kind: "text",
          path,
          ...versions(path, base, local, remote),
          parts,
        });
    } else
      conflicts.push({
        kind: "file",
        path,
        ...versions(path, base, local, remote),
      });
    if (value !== undefined) files[path] = value;
  }
  return { files, conflicts };
}

// Keys identify only a stored conflict plan, not persistent documents/nodes.
export function conflictOptions(conflict: Conflict) {
  if (conflict.kind === "text") {
    let number = 0;
    return conflict.parts.flatMap((part) =>
      "text" in part ? [] : [{ ...part, label: "冲突片段 " + ++number }],
    );
  }
  if (conflict.kind === "graph") {
    const display = (files: Files) =>
      conflict.paths
        .map((p) => p + "\n" + (files[p] ?? "（文件不存在）"))
        .join("\n\n");
    return [
      {
        key: conflict.path,
        label: "导图与关系整组",
        local: display(conflict.localFiles),
        remote: display(conflict.remoteFiles),
      },
    ];
  }
  return [
    {
      key: conflict.path,
      label: "整个文件（新建或删除冲突）",
      local: conflict.local,
      remote: conflict.remote,
    },
  ];
}

export function resolveMerge(result: MergeResult, choices: Choices): Files {
  const files = { ...result.files };
  function choose(key: string) {
    const side = choices[key];
    if (side !== "local" && side !== "remote")
      throw new Error("请为每个冲突项选择一版");
    return side;
  }
  for (const conflict of result.conflicts) {
    if (conflict.kind === "text") {
      files[conflict.path] = conflict.parts
        .map((part) =>
          "text" in part ? part.text : (part[choose(part.key)] ?? ""),
        )
        .join("");
    } else if (conflict.kind === "graph") {
      const selected =
        choose(conflict.path) === "local"
          ? conflict.localFiles
          : conflict.remoteFiles;
      for (const path of conflict.paths) delete files[path];
      Object.assign(files, selected);
    } else {
      const value = conflict[choose(conflict.path)];
      if (value === null) delete files[conflict.path];
      else files[conflict.path] = value;
    }
  }
  // Validate before replacing local state or clearing a conflict.
  validateFiles(files);
  return files;
}
