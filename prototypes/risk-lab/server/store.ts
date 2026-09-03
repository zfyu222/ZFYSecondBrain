import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  type Snapshot,
  type Change,
  validateFiles,
  pathSchema,
} from "../src/core/contracts";
import { moveNote } from "../src/core/paths";
import { sampleFiles } from "../src/core/seed";

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
    private failAfter?: number,
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
    return { revision: digest(sorted), files: sorted };
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
    await fs.unlink(journalPath);
  }
  private async commitUnsafe(
    change: Change,
    fingerprint = digest(change),
  ): Promise<Snapshot> {
    await this.recover();
    try {
      validateFiles(change.files);
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
    if (
      before.revision !== change.expectedRevision &&
      !(change.expectedRevision === null && !Object.keys(before.files).length)
    )
      throw new ConflictError(before);
    const sorted = Object.fromEntries(
      Object.entries(change.files).sort(([a], [b]) => a.localeCompare(b)),
    );
    const after = { files: sorted, revision: digest(sorted) };
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
    // Detect observed external edits before touching originals. This is not an OS lock.
    if ((await this.readUnsafe()).revision !== before.revision)
      throw new Error("提交前发现外部修改");
    await this.apply(after.files, before.files, true);
    await this.atomicJson("ledger.json", ledgerAfter);
    await this.atomicJson("journal.json", { ...journal, status: "committed" });
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
          files: moved.files,
        },
        fingerprint,
      );
    });
  }
}
