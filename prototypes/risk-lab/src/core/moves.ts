import { moveRecordSchema, type MoveRecord, type Snapshot } from "./contracts";
import { moveNote } from "./paths";

export function moveSequence(snapshot: Snapshot | null) {
  return snapshot?.moves?.length ?? 0;
}
export function validateMoves(records: MoveRecord[]) {
  records.forEach((record, i) => {
    moveRecordSchema.parse(record);
    if (
      record.sequence !== i + 1 ||
      !record.from.endsWith(".md") ||
      !record.to.endsWith(".md") ||
      record.from === record.to
    )
      throw new Error("移动记录不连续或无效");
  });
}
export function alignMoves(
  base: Snapshot | null,
  local: Record<string, string>,
  remote: Snapshot,
) {
  const known = base?.moves ?? [],
    all = remote.moves ?? [];
  validateMoves(known);
  validateMoves(all);
  if (
    known.length > all.length ||
    known.some((m, i) => JSON.stringify(m) !== JSON.stringify(all[i]))
  )
    throw new Error("服务端移动记录缺失或与本机基线不同，停止同步并保留草稿");
  let baseFiles = { ...(base?.files ?? {}) },
    files = { ...local };
  for (const move of all.slice(known.length)) {
    const stem = move.from.slice(0, -3);
    const localBundle = Object.keys(files).some(
      (p) =>
        p === move.from ||
        [".opml", ".relations.yaml", ".note.yaml"].some(
          (ext) => p === stem + ext,
        ) ||
        p.startsWith(stem + ".assets/"),
    );
    if (!(move.from in baseFiles) && localBundle)
      throw new Error(
        `本机新增内容与历史移动同名，无法确认归属：${move.from}；请先导出草稿`,
      );
    const knownPaths = [
      ...Object.keys(baseFiles),
      ...Object.keys(files),
      ...(move.paths ?? []),
    ];
    baseFiles = moveNote(
      baseFiles,
      move.from,
      move.to,
      false,
      knownPaths,
    ).files;
    files = moveNote(files, move.from, move.to, false, knownPaths).files;
  }
  return { baseFiles, files };
}
