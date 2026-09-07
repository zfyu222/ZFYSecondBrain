import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dualViewChanges, readDualView } from "../src/core/dual-view";
import type { Snapshot } from "../src/core/contracts";
import { FileStore, RejectedError } from "./store";

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

const candidateSchema = z
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
    message: z.string(),
  })
  .strict();
export type MemoryRun = z.infer<typeof runSchema>;

const stateSchema = z
  .object({
    version: z.literal(1),
    config: memoryConfigSchema,
    lastScheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    runs: z.array(runSchema).max(100),
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
      .filter((file) => file.endsWith(".md"))
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
  getState() {
    return this.exclusive(() => this.read());
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
  runManual() {
    return this.exclusive(() => this.run("manual"));
  }
  runDue(now = new Date()) {
    return this.exclusive(async () => {
      const state = await this.read();
      const { date, time } = localParts(now);
      if (
        !state.config.enabled ||
        time !== state.config.localTime ||
        state.lastScheduledDate === date
      )
        return undefined;
      return this.run("scheduled", date, state);
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
      message: candidates.length
        ? "已按授权范围形成计划；未配置真实模型，未修改知识库"
        : "本次没有需要处理的已同步内容",
    };
    await this.write({
      ...state,
      ...(scheduledDate ? { lastScheduledDate: scheduledDate } : {}),
      runs: [...state.runs, run].slice(-100),
    });
    return run;
  }
}
