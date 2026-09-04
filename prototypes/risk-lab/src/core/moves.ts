import { moveRecordSchema, type MoveRecord, type Snapshot } from "./contracts";
import { moveNote } from "./paths";
import { relocateAttachments, type Attachments } from "./attachments";
import { validateContent } from "./contracts";

export function moveSequence(snapshot: Snapshot | null) {
  return snapshot?.moves?.length ?? 0;
}
export function validateMoves(records: MoveRecord[]) {
  records.forEach((record, i) => {
    moveRecordSchema.parse(record);
    if (
      record.sequence !== i + 1 ||
      (record.from.endsWith(".md") !== record.to.endsWith(".md")) ||
      record.from === record.to
    )
      throw new Error("移动记录不连续或无效");
  });
}
export function alignMoves(
  base: Snapshot | null,
  local: Record<string, string>,
  remote: Snapshot,
  localAttachments: Attachments = {},
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
  let baseAttachments = { ...(base?.attachments ?? {}) },
    attachments = { ...localAttachments };
  for (const move of all.slice(known.length)) {
    const documentMove = move.from.endsWith(".md");
    const stem = documentMove ? move.from.slice(0, -3) : move.from;
    const belongsToMove = (p: string) =>
      documentMove
        ? p === move.from ||
          [".opml", ".relations.yaml", ".note.yaml"].some(
            (ext) => p === stem + ext,
          ) ||
          p.startsWith(stem + ".assets/")
        : p.startsWith(stem + "/");
    const localBundle = [
      ...Object.keys(files),
      ...Object.keys(attachments),
    ].some(belongsToMove);
    const baseBundle = [
      ...Object.keys(baseFiles),
      ...Object.keys(baseAttachments),
    ].some(belongsToMove);
    if (!baseBundle && localBundle)
      throw new Error(
        `本机新增内容与历史移动同名，无法确认归属：${move.from}；请先导出草稿`,
      );
    const knownPaths = [
      ...Object.keys(baseFiles),
      ...Object.keys(files),
      ...Object.keys(baseAttachments),
      ...Object.keys(attachments),
      ...(move.paths ?? []),
    ];
    const baseMoved = moveNote(
      baseFiles,
      move.from,
      move.to,
      false,
      knownPaths,
    );
    const localMoved = moveNote(files, move.from, move.to, false, knownPaths);
    baseFiles = baseMoved.files;
    files = localMoved.files;
    baseAttachments = relocateAttachments(baseAttachments, baseMoved.moves);
    attachments = relocateAttachments(attachments, localMoved.moves);
    if (
      Object.keys(attachments).length ||
      Object.keys(baseAttachments).length
    ) {
      validateContent(baseFiles, baseAttachments);
      validateContent(files, attachments);
    }
  }
  return { baseFiles, files, baseAttachments, attachments };
}
