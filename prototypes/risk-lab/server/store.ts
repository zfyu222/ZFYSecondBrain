import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  type Snapshot,
  type Change,
  type MoveRecord,
  validateFiles,
  pathSchema,
} from "../src/core/contracts";
import { moveNote } from "../src/core/paths";
import { sampleFiles } from "../src/core/seed";
import { validateMoves } from "../src/core/moves";

const digest = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
type Ledger = Record<string, { fingerprint: string; result: Snapshot }>;
type Journal = {
  version: 1;
  status: "prepared" | "committed";
  before: Snapshot;
  after: Snapshot;
  ledgerBefore: Ledger;
  ledgerAfter: Ledger;
};
export class ConflictError extends Error {
  constructor(public snapshot: Snapshot) {
    super("来源版本已变化");
  }
}
export class RejectedError extends Error {}
export class FileStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    public root: string,
    private failAfter?:
      | number
      | "prepared"
      | "files"
      | "ledger"
      | "moves"
      | "committed",
  ) {}
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async safePath(relative: string): Promise<string> {
    pathSchema.parse(relative);
    let current = this.root;
    for (const part of relative.split("/")) {
      const names = await fs
        .readdir(current)
        .catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
          return [];
        });
      const alias = names.find(
        (name) =>
          name.normalize("NFC").toLocaleLowerCase("en-US") ===
          part.normalize("NFC").toLocaleLowerCase("en-US"),
      );
      if (alias !== undefined && alias !== part)
        throw new Error("已有路径的大小写或 Unicode 拼写不同：" + part);
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return undefined;
      });
      if (stat?.isSymbolicLink()) throw new Error("拒绝符号链接路径");
    }
    return current;
  }
  private async atomicJson(name: string, data: unknown) {
    const dest = path.join(this.root, "state", name),
      temp = `${dest}.tmp`;
    const handle = await fs.open(temp, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, dest);
  }
  private async ledger(): Promise<Ledger> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.root, "state", "ledger.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }
  private fail(point: string) {
    if (this.failAfter === point) throw new Error("INJECTED_CRASH:" + point);
  }
  private async movements(): Promise<MoveRecord[]> {
    try {
      const data = JSON.parse(
        await fs.readFile(path.join(this.root, "state", "moves.json"), "utf8"),
      );
      if (data.version !== 1 || !Array.isArray(data.records))
        throw new Error("未知移动记录格式");
      validateMoves(data.records);
      return data.records;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async init(seed = true) {
    this.root = path.resolve(this.root);
    const rootStat = await fs.lstat(this.root).catch(() => undefined);
    if (rootStat?.isSymbolicLink()) throw new Error("原型根目录不能是符号链接");
    await fs.mkdir(this.root, { recursive: true });
    const marker = path.join(this.root, ".risk-lab");
    try {
      if ((await fs.readFile(marker, "utf8")) !== "risk-lab-v1")
        throw new Error("未知原型目录");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if ((await fs.readdir(this.root)).length)
        throw new Error("拒绝接管非空目录：请使用独立原型数据");
      await fs.writeFile(marker, "risk-lab-v1", { flag: "wx" });
    }
    for (const name of ["raw", "derived", "state"]) {
      const dest = path.join(this.root, name);
      const stat = await fs.lstat(dest).catch(() => undefined);
      if (stat?.isSymbolicLink()) throw new Error("原型目录不能含符号链接");
      await fs.mkdir(dest, { recursive: true });
    }
    await this.recover();
    const snapshot = await this.readUnsafe();
    if (seed && !Object.keys(snapshot.files).length)
      await this.commit({
        requestId: "initial-seed-v1",
        expectedRevision: snapshot.revision,
        moveSequence: snapshot.moves?.length ?? 0,
        files: sampleFiles(),
      });
  }
  private async readUnsafe(): Promise<Snapshot> {
    const files: Record<string, string> = {};
    const walk = async (prefix: string) => {
      for (const item of await fs.readdir(path.join(this.root, prefix), {
        withFileTypes: true,
      })) {
        if (item.isSymbolicLink()) throw new Error("原型不读取符号链接");
        const rel = `${prefix}/${item.name}`;
        if (item.isDirectory()) await walk(rel);
        else if (item.isFile()) {
          if (item.name.endsWith(".risk-tmp")) continue;
          const bytes = await fs.readFile(await this.safePath(rel));
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
          files[rel] = decoded;
        }
      }
    };
    await walk("raw");
    await walk("derived");
    const sorted = Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
    );
    const moves = await this.movements();
    return {
      revision: moves.length
        ? digest({ files: sorted, moves })
        : digest(sorted),
      files: sorted,
      moves,
    };
  }
  snapshot() {
    return this.exclusive(async () => {
      await this.recover();
      return this.readUnsafe();
    });
  }
  private async apply(
    files: Record<string, string>,
    current: Record<string, string>,
    inject = false,
  ) {
    let writes = 0;
    for (const rel of [
      ...new Set([...Object.keys(current), ...Object.keys(files)]),
    ].sort()) {
      if (current[rel] === files[rel]) continue;
      const dest = await this.safePath(rel);
      if (!(rel in files)) await fs.unlink(dest);
      else {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const temp = `${dest}.risk-tmp`;
        const handle = await fs.open(temp, "w");
        try {
          await handle.writeFile(files[rel]);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, dest);
      }
      if (inject && ++writes === this.failAfter)
        throw new Error("INJECTED_CRASH");
    }
  }
  async recover() {
    const journalPath = path.join(this.root, "state", "journal.json");
    let journal: Journal;
    try {
      journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (journal.version !== 1) throw new Error("未知事务日志");
    const current = await this.readUnsafe();
    const movementState = JSON.stringify(current.moves ?? []);
    if (
      movementState !== JSON.stringify(journal.before.moves ?? []) &&
      movementState !== JSON.stringify(journal.after.moves ?? [])
    )
      throw new Error("恢复期间发现外部移动记录修改，保留现场并停止");
    for (const rel of new Set([
      ...Object.keys(current.files),
      ...Object.keys(journal.before.files),
      ...Object.keys(journal.after.files),
    ])) {
      if (
        current.files[rel] !== journal.before.files[rel] &&
        current.files[rel] !== journal.after.files[rel]
      )
        throw new Error("恢复期间发现外部修改，保留现场并停止");
    }
    const committed = journal.status === "committed";
    await this.apply(
      committed ? journal.after.files : journal.before.files,
      current.files,
    );
    await this.atomicJson(
      "ledger.json",
      committed ? journal.ledgerAfter : journal.ledgerBefore,
    );
    await this.atomicJson("moves.json", {
      version: 1,
      records: (committed ? journal.after.moves : journal.before.moves) ?? [],
    });
    await fs.unlink(journalPath);
  }
  private async commitUnsafe(
    change: Change,
    fingerprint = digest(change),
    movement?: { from: string; to: string; paths: string[] },
  ): Promise<Snapshot> {
    await this.recover();
    try {
      validateFiles(change.files);
      for (const relative of Object.keys(change.files))
        await this.safePath(relative);
    } catch (e) {
      throw new RejectedError(String(e));
    }
    const ledgerBefore = await this.ledger();
    if (ledgerBefore[change.requestId]) {
      if (ledgerBefore[change.requestId].fingerprint !== fingerprint)
        throw new Error("幂等键不能用于不同请求");
      return ledgerBefore[change.requestId].result;
    }
    const before = await this.readUnsafe();
    if ((change.moveSequence ?? 0) !== (before.moves?.length ?? 0))
      throw new ConflictError(before);
    if (
      before.revision !== change.expectedRevision &&
      !(change.expectedRevision === null && !Object.keys(before.files).length)
    )
      throw new ConflictError(before);
    const sorted = Object.fromEntries(
      Object.entries(change.files).sort(([a], [b]) => a.localeCompare(b)),
    );
    const moves = [...(before.moves ?? [])];
    if (movement)
      moves.push({
        sequence: moves.length + 1,
        ...movement,
        at: new Date().toISOString(),
      });
    const after: Snapshot = {
      files: sorted,
      revision: moves.length
        ? digest({ files: sorted, moves })
        : digest(sorted),
      moves,
    };
    const ledgerAfter = {
      ...ledgerBefore,
      [change.requestId]: { fingerprint, result: after },
    };
    const journal: Journal = {
      version: 1,
      status: "prepared",
      before,
      after,
      ledgerBefore,
      ledgerAfter,
    };
    await this.atomicJson("journal.json", journal);
    this.fail("prepared");
    // Detect observed external edits before touching originals. This is not an OS lock.
    if ((await this.readUnsafe()).revision !== before.revision)
      throw new Error("提交前发现外部修改");
    await this.apply(after.files, before.files, true);
    this.fail("files");
    if (digest((await this.readUnsafe()).files) !== digest(after.files))
      throw new Error("落盘内容与提交不一致，停止并保留恢复日志");
    await this.atomicJson("ledger.json", ledgerAfter);
    this.fail("ledger");
    await this.atomicJson("moves.json", { version: 1, records: moves });
    this.fail("moves");
    await this.atomicJson("journal.json", { ...journal, status: "committed" });
    this.fail("committed");
    await fs.unlink(path.join(this.root, "state", "journal.json"));
    return after;
  }
  commit(change: Change) {
    return this.exclusive(() => this.commitUnsafe(change));
  }
  move(input: {
    requestId: string;
    expectedRevision: string;
    from: string;
    to: string;
  }) {
    return this.exclusive(async () => {
      await this.recover();
      const fingerprint = digest({ kind: "move", ...input });
      const previous = (await this.ledger())[input.requestId];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error("幂等键不能用于不同请求");
        return previous.result;
      }
      const before = await this.readUnsafe();
      if (before.revision !== input.expectedRevision)
        throw new ConflictError(before);
      let moved;
      try {
        moved = moveNote(before.files, input.from, input.to);
      } catch (e) {
        throw new RejectedError(String(e));
      }
      return this.commitUnsafe(
        {
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          moveSequence: before.moves?.length ?? 0,
          files: moved.files,
        },
        fingerprint,
        {
          from: input.from,
          to: input.to,
          paths: Object.keys(before.files).filter((p) => p in moved.moves),
        },
      );
    });
  }
}
