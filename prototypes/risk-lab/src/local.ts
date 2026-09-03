import Dexie, { type Table } from "dexie";
import { validateFiles, type Change, type Snapshot } from "./core/contracts";
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
};
export type LocalState = {
  id: string;
  version: number;
  files: Record<string, string>;
  base: Snapshot | null;
  pending: Change | null;
  pendingMove?: MoveRequest | null;
  conflict: {
    formatVersion?: 2;
    baseFiles?: Record<string, string>;
    remote: Snapshot;
    merged: Record<string, string>;
    items: Conflict[];
  } | null;
};
type Recovery = { id: string; at: string; state: LocalState };
export class LocalVault extends Dexie {
  vault!: Table<LocalState, string>;
  recovery!: Table<Recovery, string>;
  constructor(name = "zfy-risk-lab-v1") {
    super(name);
    this.version(1).stores({ vault: "id" });
    this.version(2).stores({ vault: "id", recovery: "id,at" });
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
function conflictState(
  remote: Snapshot,
  baseFiles: Record<string, string>,
  result: MergeResult,
): NonNullable<LocalState["conflict"]> {
  return {
    formatVersion: 2,
    baseFiles,
    remote,
    merged: result.files,
    items: result.conflicts,
  };
}
export function hasUnsyncedChanges(row: LocalState) {
  if (row.pending || row.pendingMove || row.conflict || !row.base) return true;
  return [
    ...new Set([...Object.keys(row.files), ...Object.keys(row.base.files)]),
  ].some((p) => row.files[p] !== row.base!.files[p]);
}
export async function requestSnapshot(): Promise<Snapshot> {
  const response = await fetch("/api/snapshot", {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("测试服务不可用");
  return response.json();
}
export async function synchronize(db: LocalVault): Promise<LocalState> {
  let row = await db.read();
  if (row.pendingMove) row = await resumeMove(db, row);
  if (row.conflict) return row;
  // Persist exact outbound payload. Retrying after a lost response must reuse it.
  if (!row.pending) {
    const remote = await requestSnapshot();
    const aligned = alignMoves(row.base, row.files, remote);
    const result = mergeFiles(aligned.baseFiles, aligned.files, remote.files);
    if (result.conflicts.length)
      return db.update(row.version, (r) => ({
        ...r,
        conflict: conflictState(remote, aligned.baseFiles, result),
      }));
    validateFiles(result.files);
    row = await db.update(row.version, (r) => ({
      ...r,
      files: result.files,
      base: remote,
      pending: {
        requestId: crypto.randomUUID(),
        expectedRevision: remote.revision,
        moveSequence: moveSequence(remote),
        files: result.files,
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
    const remote = payload.snapshot as Snapshot;
    // Invalidate only the request. The local changes and previous base survive.
    const latest = await db.read();
    if (latest.pending?.requestId !== pending.requestId) return latest;
    const aligned = alignMoves(latest.base, latest.files, remote);
    return db.update(latest.version, (r) => ({
      ...r,
      pending: null,
      conflict: conflictState(
        remote,
        aligned.baseFiles,
        mergeFiles(aligned.baseFiles, aligned.files, remote.files),
      ),
    }));
  }
  if (!response.ok) throw new Error(payload.error ?? "同步失败");
  const committed = payload as Snapshot;
  const latest = await db.read();
  if (latest.pending?.requestId !== pending.requestId) return latest;
  const merged = mergeFiles(pending.files, latest.files, committed.files);
  return db.update(latest.version, (r) => ({
    ...r,
    files: merged.conflicts.length ? r.files : merged.files,
    base: committed,
    pending: null,
    conflict: merged.conflicts.length
      ? conflictState(committed, pending.files, merged)
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
    await db.recovery.add({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      state: structuredClone(current),
    });
    return db.update(row.version, (r) => ({
      ...r,
      files,
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
  return db.update(row.version, (r) => ({
    ...r,
    files: payload.files,
    base: payload,
    pendingMove: null,
  }));
}
export async function moveDocument(db: LocalVault, from: string, to: string) {
  let row = await synchronize(db);
  if (row.conflict || row.pending || !row.base)
    throw new Error("先解决同步冲突");
  row = await db.update(row.version, (r) => ({
    ...r,
    pendingMove: {
      from,
      to,
      expectedRevision: row.base!.revision,
      requestId: crypto.randomUUID(),
    },
  }));
  return resumeMove(db, row);
}
