import Dexie, { type Table } from "dexie";
import { z } from "zod";
import {
  validateContent,
  type Change,
  type Snapshot,
  snapshotPayloadSchema,
  filesSchema,
  attachmentsSchema,
  pathSchema,
} from "./core/contracts";
import {
  encodeAttachment,
  mergeAttachments,
  resolveAttachments,
  sameAttachment,
  type Attachments,
  type AttachmentConflict,
} from "./core/attachments";
import {
  mergeFiles,
  resolveMerge,
  type Conflict,
  type MergeResult,
} from "./core/merge";
import { sampleFiles } from "./core/seed";
import { alignMoves, moveSequence } from "./core/moves";

export type MoveRequest = {
  requestId: string;
  expectedRevision: string;
  from: string;
  to: string;
  protocolVersion?: 2;
};
export type LocalState = {
  id: string;
  version: number;
  files: Record<string, string>;
  attachments?: Attachments;
  base: Snapshot | null;
  pending: Change | null;
  pendingMove?: MoveRequest | null;
  /** Readable note stems, used only as local UI state and never as note identity. */
  recent?: Record<string, string>;
  conflict: {
    formatVersion?: 2;
    baseFiles?: Record<string, string>;
    remote: Snapshot;
    merged: Record<string, string>;
    items: Conflict[];
    attachments?: Attachments;
    attachmentItems?: AttachmentConflict[];
  } | null;
};
type Recovery = { id: string; at: string; state: LocalState };
export type HistoryPoint = {
  id: string;
  path: string;
  at: string;
  content: string;
};
const emergencyExportSchema = z
  .object({
    protocolVersion: z.literal(2),
    files: filesSchema,
    attachments: attachmentsSchema,
  })
  .strict();

export function readEmergencyExport(input: unknown) {
  const exported = emergencyExportSchema.parse(input);
  validateContent(exported.files, exported.attachments);
  return exported;
}
export class LocalVault extends Dexie {
  vault!: Table<LocalState, string>;
  recovery!: Table<Recovery, string>;
  history!: Table<HistoryPoint, string>;
  constructor(name = "zfy-risk-lab-v1") {
    super(name);
    this.version(1).stores({ vault: "id" });
    this.version(2).stores({ vault: "id", recovery: "id,at" });
    this.version(3).stores({ vault: "id", recovery: "id,at" });
    this.version(4).stores({
      vault: "id",
      recovery: "id,at",
      history: "id,path,at",
    });
  }
  async read() {
    return this.transaction("rw", this.vault, this.recovery, async () => {
      let row = await this.vault.get("vault");
      if (!row) {
        row = {
          id: "vault",
          version: 0,
          files: sampleFiles(),
          base: null,
          pending: null,
          conflict: null,
        };
        await this.vault.add(row);
      }
      if (
        row.conflict &&
        row.conflict.formatVersion !== undefined &&
        row.conflict.formatVersion !== 2
      )
        throw new Error("未知冲突格式，请升级客户端；原数据保留");
      if (row.conflict && row.conflict.formatVersion !== 2) {
        // Upgrade pending conflicts, not just newly detected ones. Preserve the
        // entire legacy state before rebuilding a versioned choice plan.
        await this.recovery.add({
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          state: structuredClone(row),
        });
        const base = { ...(row.base?.files ?? {}) };
        for (const item of row.conflict.items) {
          if (item.base === null) delete base[item.path];
          else base[item.path] = item.base;
        }
        row = {
          ...row,
          version: row.version + 1,
          conflict: conflictState(
            row.conflict.remote,
            base,
            mergeFiles(base, row.files, row.conflict.remote.files),
          ),
        };
        await this.vault.put(row);
      }
      return row;
    });
  }
  async update(expected: number, edit: (row: LocalState) => LocalState) {
    return this.transaction("rw", this.vault, async () => {
      const row = await this.vault.get("vault");
      if (!row || row.version !== expected)
        throw new Error(
          "另一个标签页已修改本机数据。当前草稿仍在编辑器，可先导出，再重新载入。",
        );
      const next = { ...edit(structuredClone(row)), version: row.version + 1 };
      await this.vault.put(next);
      return next;
    });
  }
}

export async function saveFilesWithHistory(
  db: LocalVault,
  expected: number,
  files: Record<string, string>,
  at = new Date().toISOString(),
) {
  return db.transaction("rw", db.vault, db.history, async () => {
    const row = await db.vault.get("vault");
    if (!row || row.version !== expected)
      throw new Error(
        "另一个标签页已修改本机数据。当前草稿仍在编辑器，可先导出，再重新载入。",
      );
    for (const [path, content] of Object.entries(row.files)) {
      if (files[path] === content || !path.endsWith(".md")) continue;
      const prior = (
        await db.history.where("path").equals(path).toArray()
      ).sort((a, b) => b.at.localeCompare(a.at))[0];
      if (!prior || Date.parse(at) - Date.parse(prior.at) >= 30 * 60_000)
        await db.history.add({ id: crypto.randomUUID(), path, at, content });
    }
    const next = { ...structuredClone(row), files, version: row.version + 1 };
    await db.vault.put(next);
    return next;
  });
}

export async function restoreEmergencyExport(
  db: LocalVault,
  expected: number,
  input: unknown,
) {
  const exported = readEmergencyExport(input);
  return db.transaction("rw", db.vault, db.recovery, async () => {
    const current = await db.vault.get("vault");
    if (!current || current.version !== expected)
      throw new Error("另一个标签页已修改本机数据，请重新载入后再恢复");
    // The export is a content recovery point, not a transport checkpoint. Never
    // revive an old request or move against an unknown current server revision.
    await db.recovery.add({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      state: structuredClone(current),
    });
    const restored: LocalState = {
      ...current,
      version: current.version + 1,
      files: exported.files,
      attachments: exported.attachments,
      base: null,
      pending: null,
      pendingMove: null,
      conflict: null,
    };
    await db.vault.put(restored);
    return restored;
  });
}
function conflictState(
  remote: Snapshot,
  baseFiles: Record<string, string>,
  result: MergeResult,
  attachmentResult = mergeAttachments(),
): NonNullable<LocalState["conflict"]> {
  return {
    formatVersion: 2,
    baseFiles,
    remote,
    merged: result.files,
    items: result.conflicts,
    attachments: attachmentResult.attachments,
    attachmentItems: attachmentResult.conflicts,
  };
}
export function hasUnsyncedChanges(row: LocalState) {
  if (row.pending || row.pendingMove || row.conflict || !row.base) return true;
  return (
    [
      ...new Set([...Object.keys(row.files), ...Object.keys(row.base.files)]),
    ].some((p) => row.files[p] !== row.base!.files[p]) ||
    [
      ...new Set([
        ...Object.keys(row.attachments ?? {}),
        ...Object.keys(row.base.attachments ?? {}),
      ]),
    ].some(
      (p) => !sameAttachment(row.attachments?.[p], row.base!.attachments?.[p]),
    )
  );
}

export function recentDocuments(row: LocalState) {
  return Object.entries(row.recent ?? {})
    .filter(([, at]) => !Number.isNaN(Date.parse(at)))
    .sort(([, a], [, b]) => b.localeCompare(a))
    .map(([path]) => path);
}

export async function rememberRecent(
  db: LocalVault,
  expected: number,
  path: string,
  at = new Date().toISOString(),
) {
  pathSchema.parse(path + ".md");
  if (Number.isNaN(Date.parse(at))) throw new Error("最近文档时间无效");
  return db.update(expected, (row) => ({
    ...row,
    recent: { ...row.recent, [path]: at },
  }));
}

function relocateRecent(
  recent: Record<string, string> | undefined,
  from: string,
  to: string,
) {
  const source = from.slice(0, -3),
    destination = to.slice(0, -3),
    next = { ...recent };
  if (Object.hasOwn(next, source)) {
    next[destination] = next[source];
    delete next[source];
  }
  return next;
}
function checkedSnapshot(input: unknown): Snapshot {
  if (!input || typeof input !== "object") throw new Error("无效服务端快照");
  const snapshot = input as Snapshot;
  if (snapshot.protocolVersion !== undefined && snapshot.protocolVersion !== 2)
    throw new Error("未知服务端协议，请升级客户端");
  if (typeof snapshot.revision !== "string") throw new Error("无效快照版本");
  snapshotPayloadSchema.parse(snapshot);
  if (snapshot.attachments !== undefined) {
    if (snapshot.protocolVersion !== 2) throw new Error("附件缺少协议版本");
  }
  validateContent(snapshot.files, snapshot.attachments);
  return snapshot;
}
export async function requestSnapshot(): Promise<Snapshot> {
  const response = await fetch("/api/snapshot", {
    cache: "no-store",
    headers: { "X-Vault-Protocol": "2" },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("测试服务不可用");
  return checkedSnapshot(await response.json());
}
export async function synchronize(db: LocalVault): Promise<LocalState> {
  let row = await db.read();
  if (row.pendingMove) row = await resumeMove(db, row);
  if (row.conflict) return row;
  // Persist exact outbound payload. Retrying after a lost response must reuse it.
  if (!row.pending) {
    const remote = await requestSnapshot();
    const aligned = alignMoves(row.base, row.files, remote, row.attachments);
    const result = mergeFiles(aligned.baseFiles, aligned.files, remote.files);
    const attachmentResult = mergeAttachments(
      aligned.baseAttachments,
      aligned.attachments,
      remote.attachments,
    );
    if (result.conflicts.length || attachmentResult.conflicts.length)
      return db.update(row.version, (r) => ({
        ...r,
        conflict: conflictState(
          remote,
          aligned.baseFiles,
          result,
          attachmentResult,
        ),
      }));
    validateContent(result.files, attachmentResult.attachments);
    row = await db.update(row.version, (r) => ({
      ...r,
      files: result.files,
      attachments: attachmentResult.attachments,
      base: remote,
      pending: {
        requestId: crypto.randomUUID(),
        expectedRevision: remote.revision,
        moveSequence: moveSequence(remote),
        files: result.files,
        protocolVersion: 2,
        attachments: attachmentResult.attachments,
      },
    }));
  }
  const pending = row.pending!;
  const response = await fetch("/api/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pending),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json();
  if (response.status === 409) {
    const remote = checkedSnapshot(payload.snapshot);
    // Invalidate only the request. The local changes and previous base survive.
    const latest = await db.read();
    if (latest.pending?.requestId !== pending.requestId) return latest;
    const aligned = alignMoves(
      latest.base,
      latest.files,
      remote,
      latest.attachments,
    );
    return db.update(latest.version, (r) => ({
      ...r,
      pending: null,
      conflict: conflictState(
        remote,
        aligned.baseFiles,
        mergeFiles(aligned.baseFiles, aligned.files, remote.files),
        mergeAttachments(
          aligned.baseAttachments,
          aligned.attachments,
          remote.attachments,
        ),
      ),
    }));
  }
  if (!response.ok) throw new Error(payload.error ?? "同步失败");
  const committed = checkedSnapshot(payload);
  const latest = await db.read();
  if (latest.pending?.requestId !== pending.requestId) return latest;
  const merged = mergeFiles(pending.files, latest.files, committed.files);
  const attachmentResult = mergeAttachments(
    pending.attachments,
    latest.attachments,
    committed.attachments,
  );
  const conflicts =
    merged.conflicts.length || attachmentResult.conflicts.length;
  if (!conflicts) validateContent(merged.files, attachmentResult.attachments);
  return db.update(latest.version, (r) => ({
    ...r,
    files: conflicts ? r.files : merged.files,
    attachments: conflicts ? r.attachments : attachmentResult.attachments,
    base: committed,
    pending: null,
    conflict: conflicts
      ? conflictState(committed, pending.files, merged, attachmentResult)
      : null,
  }));
}
export async function resolveConflicts(
  db: LocalVault,
  row: LocalState,
  choices: Record<string, "local" | "remote">,
) {
  if (!row.conflict) throw new Error("没有待处理冲突");
  return db.transaction("rw", db.vault, db.recovery, async () => {
    const current = await db.vault.get("vault");
    if (!current || current.version !== row.version)
      throw new Error("另一个标签页已更新数据，请重新载入冲突");
    if (!current.conflict || current.conflict.formatVersion !== 2)
      throw new Error("冲突格式已更新，请重新载入");
    const files = resolveMerge(
      { files: current.conflict.merged, conflicts: current.conflict.items },
      choices,
    );
    const attachments = resolveAttachments(
      current.conflict.attachments ?? {},
      current.conflict.attachmentItems ?? [],
      choices,
    );
    validateContent(files, attachments);
    await db.recovery.add({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      state: structuredClone(current),
    });
    return db.update(row.version, (r) => ({
      ...r,
      files,
      attachments,
      base: current.conflict!.remote,
      pending: null,
      conflict: null,
    }));
  });
}

async function resumeMove(db: LocalVault, row: LocalState) {
  const response = await fetch("/api/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(row.pendingMove),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json();
  if (!response.ok) {
    // Definitive rejection can be retried as a new operation; transport failures
    // keep the original request so an acknowledged-on-server move is not repeated.
    if (response.status === 400 || response.status === 409)
      await db.update(row.version, (r) => ({ ...r, pendingMove: null }));
    throw new Error(payload.error ?? "移动失败");
  }
  const moved = checkedSnapshot(payload);
  return db.update(row.version, (r) => ({
    ...r,
    files: moved.files,
    attachments: moved.attachments ?? {},
    base: moved,
    pendingMove: null,
    recent: r.pendingMove
      ? relocateRecent(r.recent, r.pendingMove.from, r.pendingMove.to)
      : r.recent,
  }));
}
export async function moveDocument(db: LocalVault, from: string, to: string) {
  let row = await synchronize(db);
  if (row.conflict || row.pending || !row.base)
    throw new Error("先解决同步冲突");
  row = await db.update(row.version, (r) => ({
    ...r,
    pendingMove: {
      protocolVersion: 2,
      from,
      to,
      expectedRevision: row.base!.revision,
      requestId: crypto.randomUUID(),
    },
  }));
  return resumeMove(db, row);
}

export async function addAttachment(
  db: LocalVault,
  expected: number,
  owner: string,
  filename: string,
  bytes: Uint8Array,
) {
  const value = encodeAttachment(bytes);
  return db.update(expected, (row) => {
    if (row.conflict || row.pendingMove)
      throw new Error("先处理冲突或待确认移动");
    if (!owner.endsWith(".md") || !Object.hasOwn(row.files, owner))
      throw new Error("附件需要已有 Markdown 文档");
    if (filename.includes("/") || filename.includes("\\"))
      throw new Error("附件名称不能含目录");
    const target = owner.slice(0, -3) + ".assets/" + filename;
    if (
      Object.hasOwn(row.attachments ?? {}, target) ||
      Object.hasOwn(row.files, target)
    )
      throw new Error("同名附件已存在，请先重命名要添加的文件");
    const attachments = { ...row.attachments, [target]: value };
    const link = target.split("/").map(encodeURIComponent).join("/");
    const files = {
      ...row.files,
      [owner]: row.files[owner] + `\n\n![[${link}]]\n`,
    };
    validateContent(files, attachments);
    return { ...row, files, attachments };
  });
}
