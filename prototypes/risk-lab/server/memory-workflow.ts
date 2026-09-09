import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { dualViewChanges, readDualView, recordDualView } from "../src/core/dual-view";
import type { Snapshot } from "../src/core/contracts";
import { parseSummary, serializeSummary, summaryPath, validateSummary } from "../src/core/summaries";
import { ConflictError, FileStore, RejectedError } from "./store";

const capabilitiesSchema = z
  .object({ summaries: z.boolean(), inbox: z.boolean(), dualView: z.boolean() })
  .strict();
export const memoryConfigSchema = z
  .object({
    enabled: z.boolean(),
    localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    capabilities: capabilitiesSchema,
  })
  .strict();
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

export const candidateSchema = z
  .object({
    capability: z.enum(["summaries", "inbox", "dualView"]),
    path: z.string(),
    reason: z.string(),
  })
  .strict();
const runSchema = z
  .object({
    id: z.string().uuid(),
    trigger: z.enum(["scheduled", "manual"]),
    scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    sourceRevision: z.string(),
    startedAt: z.string().datetime(),
    status: z.enum(["completed", "awaiting-manager"]),
    candidates: z.array(candidateSchema),
    processed: z.array(z.string()).max(300).default([]),
    message: z.string(),
  })
  .strict();
export type MemoryRun = z.infer<typeof runSchema>;
export type MemoryCandidate = z.infer<typeof candidateSchema>;

const summaryResultSchema = z
  .object({
    runId: z.string().uuid(),
    sourcePath: z.string().startsWith("raw/").endsWith(".md"),
    summary: z.unknown(),
  })
  .strict();

const inboxResultSchema = z
  .object({
    runId: z.string().uuid(),
    sourcePath: z.string().startsWith("raw/Inbox/").endsWith(".md"),
    destination: z.string().regex(/^raw\/(Projects|Areas)\/.+\.md$/),
    tags: z.array(z.string()).min(1).max(20),
    confidence: z.enum(["high", "needs-confirmation"]),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
const dualViewResultSchema = z
  .object({
    runId: z.string().uuid(),
    stem: z.string().regex(/^raw\/(Inbox|Projects|Areas)\/.+$/),
    markdown: z.string().min(1).max(2_000_000),
    opml: z.string().min(1).max(2_000_000),
    rationale: z.string().min(1).max(2000),
  })
  .strict();
const confirmationSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    capability: z.literal("inbox"),
    sourcePath: z.string(),
    destination: z.string(),
    tags: z.array(z.string()),
    rationale: z.string(),
    sourceRevision: z.string(),
    createdAt: z.string().datetime(),
    status: z.enum(["pending", "applied", "rejected", "stale"]),
  })
  .strict();
export type MemoryConfirmation = z.infer<typeof confirmationSchema>;
const notificationSchema = z
  .object({
    id: z.string().uuid(),
    level: z.enum(["info", "error"]),
    message: z.string().min(1).max(2000),
    createdAt: z.string().datetime(),
    read: z.boolean(),
    runId: z.string().uuid().optional(),
  })
  .strict();
export type MemoryNotification = z.infer<typeof notificationSchema>;

const stateSchema = z
  .object({
    version: z.literal(1),
    config: memoryConfigSchema,
    lastScheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    // A missed schedule is recorded separately from a completed scheduled run.
    // This prevents a late server start from silently running unanticipated work.
    lastMissedScheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    runs: z.array(runSchema).max(100),
    // Defaults retain existing v1 state files created before these queues.
    confirmations: z.array(confirmationSchema).max(100).default([]),
    notifications: z.array(notificationSchema).max(100).default([]),
  })
  .strict();
type MemoryState = z.infer<typeof stateSchema>;
const defaultState: MemoryState = {
  version: 1,
  config: {
    enabled: false,
    localTime: "03:00",
    capabilities: { summaries: false, inbox: false, dualView: false },
  },
  runs: [],
  confirmations: [],
  notifications: [],
};

function localParts(now: Date) {
  const part = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}`,
    time: `${part(now.getHours())}:${part(now.getMinutes())}`,
  };
}

export function planMemoryRun(snapshot: Snapshot, config: MemoryConfig) {
  const candidates: z.infer<typeof candidateSchema>[] = [];
  const files = snapshot.files;
  if (config.capabilities.summaries)
    for (const file of Object.keys(files).filter(
      (file) =>
        file.endsWith(".md") &&
        file.startsWith("raw/") &&
        !file.startsWith("raw/Archive/"),
    ))
      candidates.push({
        capability: "summaries",
        path: file,
        reason: "需要由管理员检查新增或变化内容的多级摘要",
      });
  if (config.capabilities.inbox)
    for (const file of Object.keys(files).filter(
      (file) => file.startsWith("raw/Inbox/") && file.endsWith(".md"),
    ))
      candidates.push({
        capability: "inbox",
        path: file,
        reason: "等待管理员判断分类、标签和目标路径",
      });
  if (config.capabilities.dualView) {
    const stems = Object.keys(files)
      .filter((file) => file.endsWith(".md") && !file.startsWith("raw/Archive/"))
      .map((file) => file.slice(0, -3))
      .filter((stem) => Object.hasOwn(files, `${stem}.opml`));
    for (const stem of stems) {
      try {
        const changes = dualViewChanges(
          readDualView(files[`${stem}.note.yaml`] ?? ""),
          files[`${stem}.md`],
          files[`${stem}.opml`],
        );
        if (changes.markdown || changes.opml)
          candidates.push({
            capability: "dualView",
            path: stem,
            reason: changes.known
              ? `共同版本后有变化：${changes.markdown ? "Markdown" : ""}${changes.markdown && changes.opml ? "、" : ""}${changes.opml ? "导图" : ""}`
              : "尚未建立双视图共同版本",
          });
      } catch {
        candidates.push({
          capability: "dualView",
          path: stem,
          reason: "双视图共同版本记录无效，需要人工检查",
        });
      }
    }
  }
  return candidates;
}

/** Persistent, single-server scheduler. It plans work but never impersonates an AI. */
export class MemoryWorkflowService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: FileStore) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private get file() {
    return path.join(this.store.root, "state", "memory-workflow.json");
  }
  private async check(file: string) {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink !== 1))
      throw new Error("记忆整理状态文件不能是链接");
  }
  private async read(): Promise<MemoryState> {
    await this.check(this.file);
    try {
      return stateSchema.parse(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState;
      throw error;
    }
  }
  private async write(state: MemoryState) {
    const temp = `${this.file}.tmp`;
    await this.check(this.file);
    await this.check(temp);
    const handle = await fs.open(temp, "w");
    try {
      await handle.writeFile(JSON.stringify(state, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, this.file);
  }
  private notify(
    state: MemoryState,
    level: MemoryNotification["level"],
    message: string,
    runId?: string,
  ): MemoryState {
    const notification: MemoryNotification = {
      id: randomUUID(), level, message, createdAt: new Date().toISOString(), read: false,
      ...(runId ? { runId } : {}),
    };
    return { ...state, notifications: [...state.notifications, notification].slice(-100) };
  }
  getState() {
    return this.exclusive(() => this.read());
  }
  getRun(id: string) {
    return this.exclusive(async () => {
      const run = (await this.read()).runs.find((item) => item.id === id);
      if (!run) throw new RejectedError("记忆整理运行记录不存在");
      return run;
    });
  }
  /** Records a manager-owned step and advances the expected server revision.
   * A later external edit cannot be mistaken for this service's own commit. */
  advanceRun(
    runId: string,
    candidate: MemoryCandidate,
    revision: string,
    message: string,
    movedTo?: string,
  ) {
    return this.exclusive(async () => {
      const state = await this.read();
      const run = state.runs.find((item) => item.id === runId);
      if (!run) throw new RejectedError("记忆整理运行记录不存在");
      if (!run.candidates.some((item) => item.capability === candidate.capability && item.path === candidate.path))
        throw new RejectedError("整理步骤不属于该次计划");
      const key = `${candidate.capability}:${candidate.path}`;
      if (run.processed.includes(key)) throw new RejectedError("该整理步骤已完成");
      const processed = [...run.processed, key];
      const completed = processed.length === run.candidates.length;
      const candidates = movedTo
        ? run.candidates.map((item) => {
            if (`${item.capability}:${item.path}` === key) return item;
            const oldStem = candidate.path.replace(/\.md$/, "");
            const newStem = movedTo.replace(/\.md$/, "");
            if (item.path === candidate.path) return { ...item, path: movedTo };
            if (item.path === oldStem) return { ...item, path: newStem };
            return item;
          })
        : run.candidates;
      const nextRun: MemoryRun = {
        ...run,
        sourceRevision: revision,
        candidates,
        processed,
        status: completed ? "completed" : "awaiting-manager",
        message: completed ? "已完成本次已授权整理" : message,
      };
      await this.write(this.notify({
        ...state,
        runs: state.runs.map((item) => item.id === runId ? nextRun : item),
      }, "info", message, runId));
      return nextRun;
    });
  }
  configure(input: unknown) {
    return this.exclusive(async () => {
      const config = memoryConfigSchema.parse(input);
      if (config.enabled && !Object.values(config.capabilities).some(Boolean))
        throw new RejectedError("启用记忆整理前至少选择一项持续授权能力");
      const state = await this.read();
      await this.write({ ...state, config });
      return config;
    });
  }
  markNotificationRead(id: string) {
    return this.exclusive(async () => {
      const state = await this.read();
      if (!state.notifications.some((item) => item.id === id))
        throw new RejectedError("整理通知不存在");
      await this.write({
        ...state,
        notifications: state.notifications.map((item) => item.id === id ? { ...item, read: true } : item),
      });
    });
  }
  recordFailure(error: unknown) {
    return this.exclusive(async () => {
      const state = await this.read();
      const message = error instanceof Error ? error.message : "每日整理发生未知错误";
      await this.write(this.notify(state, "error", `每日整理未完成：${message}`));
    });
  }
  runManual() {
    return this.exclusive(() => this.run("manual"));
  }
  runDue(now = new Date()) {
    return this.exclusive(async () => {
      const state = await this.read();
      const { date, time } = localParts(now);
      if (
        !state.config.enabled ||
        state.lastScheduledDate === date
      )
        return undefined;
      if (time < state.config.localTime) return undefined;
      if (time > state.config.localTime) {
        if (state.lastMissedScheduledDate !== date)
          await this.write(this.notify({
            ...state,
            lastMissedScheduledDate: date,
          }, "error", `已错过今日 ${state.config.localTime} 的每日整理；不会自动补跑，请按需手动执行。`));
        return undefined;
      }
      return this.run("scheduled", date, state);
    });
  }
  applySummary(input: unknown) {
    return this.exclusive(async () => {
      const result = summaryResultSchema.parse(input);
      const state = await this.read();
      const run = state.runs.find((item) => item.id === result.runId);
      if (!run) throw new RejectedError("记忆整理运行记录不存在");
      if (!state.config.capabilities.summaries)
        throw new RejectedError("未持续授权多级摘要整理");
      if (!run.candidates.some((item) => item.capability === "summaries" && item.path === result.sourcePath))
        throw new RejectedError("摘要结果不属于该次授权整理计划");
      const snapshot = await this.store.snapshot();
      if (snapshot.revision !== run.sourceRevision) throw new ConflictError(snapshot);
      const source = snapshot.files[result.sourcePath];
      if (source === undefined) throw new RejectedError("摘要来源文档已不存在");
      const summary = validateSummary(result.summary, source);
      if (summary.source_path !== result.sourcePath || summary.source_revision !== run.sourceRevision)
        throw new RejectedError("摘要来源路径或版本与整理计划不一致");
      const destination = summaryPath(result.sourcePath);
      const existing = snapshot.files[destination];
      if (existing && parseSummary(existing).layers.some((layer) => layer.source === "user-confirmed"))
        throw new RejectedError("已有用户确认的摘要，不能由自动整理覆盖");
      const committed = await this.store.commit({
        requestId: `memory-summary-${createHash("sha256").update(result.sourcePath).digest("hex").slice(0, 24)}-${result.runId}`,
        expectedRevision: run.sourceRevision,
        moveSequence: snapshot.moves?.length ?? 0,
        files: { ...snapshot.files, [destination]: serializeSummary(summary) },
        ...(snapshot.attachments
          ? { protocolVersion: 2 as const, attachments: snapshot.attachments }
          : {}),
      });
      await this.write(this.notify(state, "info", `多级摘要已更新：${result.sourcePath}`, run.id));
      return { path: destination, revision: committed.revision };
    });
  }
  applyInbox(input: unknown) {
    return this.exclusive(async () => {
      const result = inboxResultSchema.parse(input);
      const state = await this.read();
      const run = state.runs.find((item) => item.id === result.runId);
      if (!run) throw new RejectedError("记忆整理运行记录不存在");
      if (!state.config.capabilities.inbox)
        throw new RejectedError("未持续授权 Inbox 整理");
      if (!run.candidates.some((item) => item.capability === "inbox" && item.path === result.sourcePath))
        throw new RejectedError("分类结果不属于该次授权整理计划");
      const snapshot = await this.store.snapshot();
      if (snapshot.revision !== run.sourceRevision) throw new ConflictError(snapshot);
      if (!(result.sourcePath in snapshot.files))
        throw new RejectedError("Inbox 来源文档已不存在");
      if (result.confidence === "needs-confirmation") {
        const confirmation: MemoryConfirmation = {
          id: randomUUID(), runId: run.id, capability: "inbox",
          sourcePath: result.sourcePath, destination: result.destination,
          tags: result.tags, rationale: result.rationale,
          sourceRevision: run.sourceRevision, createdAt: new Date().toISOString(),
          status: "pending",
        };
        await this.write(this.notify({ ...state, confirmations: [...state.confirmations, confirmation].slice(-100) }, "info", `Inbox 分类等待确认：${result.sourcePath}`, run.id));
        return { confirmation, revision: snapshot.revision };
      }
      const committed = await this.store.classifyInbox({
        requestId: `memory-inbox-${createHash("sha256").update(result.sourcePath).digest("hex").slice(0, 24)}-${run.id}`,
        expectedRevision: run.sourceRevision, from: result.sourcePath,
        to: result.destination, tags: result.tags,
      });
      await this.write(this.notify(state, "info", `Inbox 已归类：${result.sourcePath} → ${result.destination}`, run.id));
      return { path: result.destination, revision: committed.revision };
    });
  }
  applyDualView(input: unknown) {
    return this.exclusive(async () => {
      const result = dualViewResultSchema.parse(input);
      const state = await this.read();
      const run = state.runs.find((item) => item.id === result.runId);
      if (!run) throw new RejectedError("记忆整理运行记录不存在");
      if (!state.config.capabilities.dualView)
        throw new RejectedError("未持续授权双视图整理");
      if (!run.candidates.some((item) => item.capability === "dualView" && item.path === result.stem))
        throw new RejectedError("同步结果不属于该次授权整理计划");
      const snapshot = await this.store.snapshot();
      if (snapshot.revision !== run.sourceRevision) throw new ConflictError(snapshot);
      if (!(result.stem + ".md" in snapshot.files) || !(result.stem + ".opml" in snapshot.files))
        throw new RejectedError("双视图来源已不存在");
      const committed = await this.store.commit({
        requestId: `memory-dual-${createHash("sha256").update(result.stem).digest("hex").slice(0, 24)}-${run.id}`,
        expectedRevision: run.sourceRevision,
        moveSequence: snapshot.moves?.length ?? 0,
        files: {
          ...snapshot.files,
          [`${result.stem}.md`]: result.markdown,
          [`${result.stem}.opml`]: result.opml,
          [`${result.stem}.note.yaml`]: recordDualView(result.markdown, result.opml, new Date().toISOString()),
        },
        ...(snapshot.attachments ? { protocolVersion: 2 as const, attachments: snapshot.attachments } : {}),
      });
      await this.write(this.notify(state, "info", `双视图已同步：${result.stem}`, run.id));
      return { stem: result.stem, revision: committed.revision };
    });
  }
  decideConfirmation(id: string, input: unknown) {
    return this.exclusive(async () => {
      const decision = z.object({ decision: z.enum(["accept", "reject"]) }).strict().parse(input);
      const state = await this.read();
      const confirmation = state.confirmations.find((item) => item.id === id);
      if (!confirmation) throw new RejectedError("待确认分类不存在");
      if (confirmation.status !== "pending") throw new RejectedError("该待确认分类已处理");
      if (decision.decision === "reject") {
        const confirmations = state.confirmations.map((item) => item.id === id ? { ...item, status: "rejected" as const } : item);
        await this.write(this.notify({ ...state, confirmations }, "info", `已保留在 Inbox：${confirmation.sourcePath}`, confirmation.runId));
        return { confirmation: confirmations.find((item) => item.id === id)! };
      }
      const snapshot = await this.store.snapshot();
      if (snapshot.revision !== confirmation.sourceRevision) {
        const confirmations = state.confirmations.map((item) => item.id === id ? { ...item, status: "stale" as const } : item);
        await this.write(this.notify({ ...state, confirmations }, "error", `待确认分类已过期：${confirmation.sourcePath}`, confirmation.runId));
        throw new ConflictError(snapshot);
      }
      const committed = await this.store.classifyInbox({
        requestId: `memory-confirm-${confirmation.id}`,
        expectedRevision: confirmation.sourceRevision, from: confirmation.sourcePath,
        to: confirmation.destination, tags: confirmation.tags,
      });
      const confirmations = state.confirmations.map((item) => item.id === id ? { ...item, status: "applied" as const } : item);
      await this.write(this.notify({ ...state, confirmations }, "info", `已确认 Inbox 分类：${confirmation.sourcePath}`, confirmation.runId));
      return { confirmation: confirmations.find((item) => item.id === id)!, revision: committed.revision };
    });
  }
  private async run(
    trigger: "scheduled" | "manual",
    scheduledDate?: string,
    knownState?: MemoryState,
  ) {
    const state = knownState ?? (await this.read());
    if (!state.config.enabled)
      throw new RejectedError("记忆整理尚未启用");
    const snapshot = await this.store.snapshot();
    const candidates = planMemoryRun(snapshot, state.config);
    const run: MemoryRun = {
      id: randomUUID(),
      trigger,
      ...(scheduledDate ? { scheduledDate } : {}),
      sourceRevision: snapshot.revision,
      startedAt: new Date().toISOString(),
      status: candidates.length ? "awaiting-manager" : "completed",
      candidates,
      processed: [],
      message: candidates.length
        ? "已按授权范围形成计划，等待已配置管理员处理"
        : "本次没有需要处理的已同步内容",
    };
    await this.write(this.notify({
      ...state,
      ...(scheduledDate ? { lastScheduledDate: scheduledDate } : {}),
      runs: [...state.runs, run].slice(-100),
    }, "info", run.message, run.id));
    return run;
  }
}
