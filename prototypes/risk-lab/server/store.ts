import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  type Snapshot,
  type Change,
  type MoveRecord,
  pathSchema,
  validateContent,
} from "../src/core/contracts";
import { moveNote } from "../src/core/paths";
import { sampleFiles } from "../src/core/seed";
import { validateMoves } from "../src/core/moves";
import { journalSchema, ledgerSchema, type Ledger } from "./journal";
import { noLinkedAncestors, noLinkedFile } from "./safe-path";
import {
  encodeAttachment,
  decodeAttachment,
  sameAttachment,
  isAttachmentPath,
  attachmentLimits,
  relocateAttachments,
  type Attachments,
} from "../src/core/attachments";
import { snapshotRevision } from "./snapshot";

const digest = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
type Journal = ReturnType<typeof journalSchema.parse>;
export class ConflictError extends Error {
  constructor(public snapshot: Snapshot) {
    super("来源版本已变化");
  }
}
export class RejectedError extends Error {}
// One queue per lexical root inside this Node process. This is not an OS lock;
// external editors and separate server processes still need independent fencing.
const directoryQueues = new Map<string, Promise<unknown>>();
export class FileStore {
  constructor(
    public readonly root: string,
    private failAfter?:
      | number
      | "prepared"
      | "files"
      | "ledger"
      | "moves"
      | "committed",
  ) {
    this.root = path.resolve(root);
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const key =
      process.platform === "win32"
        ? this.root.normalize("NFC").toLowerCase()
        : this.root;
    const pending = (directoryQueues.get(key) ?? Promise.resolve()).then(
      operation,
    );
    const tail = pending.catch(() => {});
    directoryQueues.set(key, tail);
    void tail.then(() => {
      if (directoryQueues.get(key) === tail) directoryQueues.delete(key);
    });
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
    await noLinkedFile(dest);
    await noLinkedFile(temp);
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
      await noLinkedFile(path.join(this.root, "state", "ledger.json"));
      return ledgerSchema.parse(
        JSON.parse(
          await fs.readFile(
            path.join(this.root, "state", "ledger.json"),
            "utf8",
          ),
        ),
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
      await noLinkedFile(path.join(this.root, "state", "moves.json"));
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
  init(seed = true) {
    return this.exclusive(() => this.initUnsafe(seed));
  }
  private async initUnsafe(seed: boolean) {
    await noLinkedAncestors(this.root);
    const incomplete = await fs
      .lstat(path.join(this.root, ".restore-incomplete"))
      .catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return undefined;
      });
    if (incomplete)
      throw new Error("恢复尚未完成：保留独立目录，不可作为知识库打开");
    const rootStat = await fs.lstat(this.root).catch(() => undefined);
    if (rootStat?.isSymbolicLink()) throw new Error("原型根目录不能是符号链接");
    await fs.mkdir(this.root, { recursive: true });
    const marker = path.join(this.root, ".risk-lab");
    try {
      await noLinkedFile(marker);
      if (
        !["risk-lab-v1", "risk-lab-v2"].includes(
          await fs.readFile(marker, "utf8"),
        )
      )
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
    await this.recoverUnsafe();
    await this.ledger();
    const snapshot = await this.readUnsafe();
    validateContent(snapshot.files, snapshot.attachments);
    if (
      seed &&
      !Object.keys(snapshot.files).length &&
      !Object.keys(snapshot.attachments ?? {}).length
    )
      await this.commitUnsafe({
        requestId: "initial-seed-v1",
        expectedRevision: snapshot.revision,
        moveSequence: snapshot.moves?.length ?? 0,
        files: sampleFiles(),
      });
  }
  private async readUnsafe(): Promise<Snapshot> {
    const files: Record<string, string> = {};
    const attachments: Attachments = {};
    let attachmentBytes = 0;
    const walk = async (prefix: string) => {
      for (const item of await fs.readdir(path.join(this.root, prefix), {
        withFileTypes: true,
      })) {
        if (item.isSymbolicLink()) throw new Error("原型不读取符号链接");
        const rel = `${prefix}/${item.name}`;
        if (item.isDirectory()) await walk(rel);
        else if (item.isFile()) {
          if (item.name.endsWith(".risk-tmp")) continue;
          const absolute = await this.safePath(rel);
          await noLinkedFile(absolute);
          if (isAttachmentPath(rel)) {
            const info = await fs.stat(absolute);
            attachmentBytes += info.size;
            if (
              info.size > attachmentLimits.single ||
              attachmentBytes > attachmentLimits.total ||
              Object.keys(attachments).length >= attachmentLimits.count
            )
              throw new Error("附件超过原型限制，未修改原文件");
            attachments[rel] = encodeAttachment(await fs.readFile(absolute));
            continue;
          }
          const bytes = await fs.readFile(absolute);
          // ignoreBOM keeps the marker in the decoded text, preserving raw bytes.
          const decoded = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
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
    const content = {
      files: sorted,
      moves,
      ...(Object.keys(attachments).length
        ? {
            protocolVersion: 2 as const,
            attachments: Object.fromEntries(
              Object.entries(attachments).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ),
          }
        : {}),
    };
    return { revision: snapshotRevision(content), ...content };
  }
  snapshot() {
    return this.exclusive(async () => {
      await this.recoverUnsafe();
      return this.readUnsafe();
    });
  }
  private async apply(
    next: Pick<Snapshot, "files" | "attachments">,
    previous: Pick<Snapshot, "files" | "attachments">,
    inject = false,
  ) {
    let writes = 0;
    const files = next.files,
      current = previous.files;
    const attachments = next.attachments ?? {},
      oldAttachments = previous.attachments ?? {};
    for (const rel of [
      ...new Set([
        ...Object.keys(current),
        ...Object.keys(files),
        ...Object.keys(attachments),
        ...Object.keys(oldAttachments),
      ]),
    ].sort()) {
      if (
        current[rel] === files[rel] &&
        sameAttachment(attachments[rel], oldAttachments[rel])
      )
        continue;
      const dest = await this.safePath(rel);
      await noLinkedFile(dest);
      if (!(rel in files) && !(rel in attachments)) await fs.unlink(dest);
      else {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const temp = `${dest}.risk-tmp`;
        await noLinkedFile(temp);
        const handle = await fs.open(temp, "w");
        try {
          await handle.writeFile(
            attachments[rel] ? decodeAttachment(attachments[rel]) : files[rel],
          );
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
  recover() {
    return this.exclusive(() => this.recoverUnsafe());
  }
  private async recoverUnsafe() {
    const journalPath = path.join(this.root, "state", "journal.json");
    let journal: Journal;
    try {
      await noLinkedFile(journalPath);
      journal = journalSchema.parse(
        JSON.parse(await fs.readFile(journalPath, "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
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
    for (const rel of new Set([
      ...Object.keys(current.attachments ?? {}),
      ...Object.keys(journal.before.attachments ?? {}),
      ...Object.keys(journal.after.attachments ?? {}),
    ])) {
      if (
        !sameAttachment(
          current.attachments?.[rel],
          journal.before.attachments?.[rel],
        ) &&
        !sameAttachment(
          current.attachments?.[rel],
          journal.after.attachments?.[rel],
        )
      )
        throw new Error("恢复期间发现外部附件修改，保留现场并停止");
    }
    const committed = journal.status === "committed";
    await this.apply(committed ? journal.after : journal.before, current);
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
    await this.recoverUnsafe();
    try {
      validateContent(change.files, change.attachments);
      if (change.attachments !== undefined && change.protocolVersion !== 2)
        throw new Error("附件需要新版协议");
      for (const relative of [
        ...Object.keys(change.files),
        ...Object.keys(change.attachments ?? {}),
      ])
        await noLinkedFile(await this.safePath(relative));
    } catch (e) {
      throw new RejectedError(String(e));
    }
    const ledgerBefore = await this.ledger();
    if (Object.hasOwn(ledgerBefore, change.requestId)) {
      if (ledgerBefore[change.requestId].fingerprint !== fingerprint)
        throw new Error("幂等键不能用于不同请求");
      return ledgerBefore[change.requestId].result;
    }
    const before = await this.readUnsafe();
    if (
      before.attachments &&
      (change.protocolVersion !== 2 || change.attachments === undefined)
    )
      throw new RejectedError(
        "当前知识库有附件，请升级客户端；旧文本快照不能覆盖附件",
      );
    if ((change.moveSequence ?? 0) !== (before.moves?.length ?? 0))
      throw new ConflictError(before);
    if (
      before.revision !== change.expectedRevision &&
      !(
        change.expectedRevision === null &&
        !Object.keys(before.files).length &&
        !Object.keys(before.attachments ?? {}).length
      )
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
    const content = {
      files: sorted,
      moves,
      ...(Object.keys(change.attachments ?? {}).length
        ? {
            protocolVersion: 2 as const,
            attachments: Object.fromEntries(
              Object.entries(change.attachments!).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ),
          }
        : {}),
    };
    const after: Snapshot = { ...content, revision: snapshotRevision(content) };
    const ledgerAfter = {
      ...ledgerBefore,
      [change.requestId]: { fingerprint, result: after },
    };
    const journal: Journal = {
      version: before.attachments || after.attachments ? 2 : 1,
      status: "prepared",
      before,
      after,
      ledgerBefore,
      ledgerAfter,
    };
    if (journal.version === 2) await this.upgradeMarker();
    await this.atomicJson("journal.json", journal);
    this.fail("prepared");
    // Detect observed external edits before touching originals. This is not an OS lock.
    if ((await this.readUnsafe()).revision !== before.revision)
      throw new Error("提交前发现外部修改");
    await this.apply(after, before, true);
    this.fail("files");
    const written = await this.readUnsafe();
    if (
      digest(written.files) !== digest(after.files) ||
      digest(written.attachments ?? {}) !== digest(after.attachments ?? {})
    )
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
  private async upgradeMarker() {
    const marker = path.join(this.root, ".risk-lab");
    await noLinkedFile(marker);
    const version = await fs.readFile(marker, "utf8");
    if (version === "risk-lab-v2") return;
    if (version !== "risk-lab-v1")
      throw new Error("原型目录标记已变化，停止升级");
    const temp = path.join(this.root, "state", "marker-v2.tmp");
    await noLinkedFile(temp);
    const handle = await fs.open(temp, "w");
    try {
      await handle.writeFile("risk-lab-v2");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, marker);
  }
  move(input: {
    requestId: string;
    expectedRevision: string;
    from: string;
    to: string;
    protocolVersion?: 2;
  }) {
    return this.exclusive(async () => {
      await this.recoverUnsafe();
      const fingerprint = digest({ kind: "move", ...input });
      const ledger = await this.ledger();
      const previous = Object.hasOwn(ledger, input.requestId)
        ? ledger[input.requestId]
        : undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error("幂等键不能用于不同请求");
        return previous.result;
      }
      const before = await this.readUnsafe();
      if (before.attachments && input.protocolVersion !== 2)
        throw new RejectedError("当前知识库有附件，请升级客户端后移动");
      if (before.revision !== input.expectedRevision)
        throw new ConflictError(before);
      let moved, movedAttachments: Attachments;
      try {
        moved = moveNote(
          before.files,
          input.from,
          input.to,
          true,
          Object.keys(before.attachments ?? {}),
        );
        movedAttachments = relocateAttachments(
          before.attachments ?? {},
          moved.moves,
        );
        validateContent(moved.files, movedAttachments);
      } catch (e) {
        throw new RejectedError(String(e));
      }
      return this.commitUnsafe(
        {
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          moveSequence: before.moves?.length ?? 0,
          files: moved.files,
          ...(before.attachments
            ? { protocolVersion: 2 as const, attachments: movedAttachments }
            : {}),
        },
        fingerprint,
        {
          from: input.from,
          to: input.to,
          paths: [
            ...Object.keys(before.files),
            ...Object.keys(before.attachments ?? {}),
          ].filter((p) => p in moved.moves),
        },
      );
    });
  }
}
