import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordDualView } from "../src/core/dual-view";
import { FileStore } from "../server/store";
import { ConflictError } from "../server/store";
import {
  MemoryWorkflowService,
  planMemoryRun,
  type MemoryConfig,
} from "../server/memory-workflow";
import { summaryPath } from "../src/core/summaries";

const config: MemoryConfig = {
  enabled: true,
  localTime: "03:00",
  capabilities: { summaries: true, inbox: true, dualView: true },
};

async function fixture() {
  const parent = path.resolve(".prototype-data/tests");
  await fs.mkdir(parent, { recursive: true });
  const store = new FileStore(await fs.mkdtemp(path.join(parent, "memory-")));
  await store.init(false);
  const md = "# 今日记录\n\n" + "内容".repeat(500);
  const opml = '<?xml version="1.0"?><opml version="2.0"><head><title>今日记录</title></head><body><outline text="今日记录"/></body></opml>';
  await store.commit({
    requestId: "memory-seed",
    expectedRevision: (await store.snapshot()).revision,
    files: {
      "raw/Inbox/今日.md": md,
      "raw/Inbox/今日.opml": opml,
      "raw/Inbox/今日.note.yaml": recordDualView(md, opml, new Date().toISOString()),
      "raw/Inbox/清单.md": "# 睡眠清单\n\n今晚早点睡",
      "raw/Areas/健康.md": "# 健康",
      "raw/Areas/索引.md": "关联：[[raw/Inbox/清单]]",
      "raw/Archive/旧.md": "# 旧资料",
    },
  });
  return { store, service: new MemoryWorkflowService(store) };
}

describe("daily memory workflow", () => {
  it("writes a planned AI summary as a version-bound derived document", async () => {
    const { store, service } = await fixture();
    await service.configure(config);
    const run = await service.runManual();
    const response = await service.applySummary({
      runId: run.id,
      sourcePath: "raw/Inbox/今日.md",
      summary: {
        version: 1,
        source_path: "raw/Inbox/今日.md",
        source_revision: run.sourceRevision,
        generated_at: "2026-09-07T03:00:00.000Z",
        layers: [
          { text: "记", source: "ai" },
          { text: "今日记录需要整理每天", source: "ai" },
          { text: "内容".repeat(50), source: "ai" },
        ],
      },
    });
    expect(response.path).toBe(summaryPath("raw/Inbox/今日.md"));
    expect((await store.snapshot()).files[response.path]).toContain("source_revision");
  });

  it("does not overwrite a confirmed summary or a changed source", async () => {
    const { store, service } = await fixture();
    await service.configure(config);
    const run = await service.runManual();
    await store.commit({
      requestId: "summary-source-edited",
      expectedRevision: run.sourceRevision,
      files: { ...(await store.snapshot()).files, "raw/Inbox/今日.md": "# 更新" },
    });
    await expect(
      service.applySummary({ runId: run.id, sourcePath: "raw/Inbox/今日.md", summary: {} }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
  it("plans only enabled first-release capabilities over server snapshots", async () => {
    const { store } = await fixture();
    const candidates = planMemoryRun(await store.snapshot(), config);
    expect(candidates.filter((item) => item.capability === "summaries")).toHaveLength(4);
    expect(candidates.filter((item) => item.capability === "inbox")).toHaveLength(2);
    expect(candidates.some((item) => item.capability === "dualView")).toBe(false);
    expect(candidates.some((item) => item.path.includes("Archive"))).toBe(false);
  });

  it("runs once per server-local date after the configured time", async () => {
    const { service } = await fixture();
    await service.configure(config);
    expect(await service.runDue(new Date(2026, 8, 7, 2, 59))).toBeUndefined();
    expect(await service.runDue(new Date(2026, 8, 7, 3, 5))).toBeUndefined();
    const run = await service.runDue(new Date(2026, 8, 7, 3, 0));
    expect(run).toMatchObject({
      trigger: "scheduled",
      scheduledDate: "2026-09-07",
      status: "awaiting-manager",
    });
    expect(await service.runDue(new Date(2026, 8, 7, 23, 0))).toBeUndefined();
  });

  it("persists schedule state and allows an explicit manual rerun", async () => {
    const { store, service } = await fixture();
    await service.configure(config);
    await service.runDue(new Date(2026, 8, 7, 3, 0));
    const reopened = new MemoryWorkflowService(store);
    const manual = await reopened.runManual();
    expect(manual.trigger).toBe("manual");
    expect((await reopened.getState()).runs).toHaveLength(2);
  });

  it("requires capability-specific authorization and never edits raw", async () => {
    const { store, service } = await fixture();
    await expect(
      service.configure({
        enabled: true,
        localTime: "03:00",
        capabilities: { summaries: false, inbox: false, dualView: false },
      }),
    ).rejects.toThrow("至少选择一项");
    const before = await store.snapshot();
    await service.configure(config);
    const run = await service.runManual();
    expect(run.message).toContain("未修改知识库");
    expect(await store.snapshot()).toEqual(before);
  });

  it("classifies high-confidence Inbox work as one tagged, reference-safe move", async () => {
    const { store, service } = await fixture();
    await service.configure(config);
    const run = await service.runManual();
    const response = await service.applyInbox({
      runId: run.id, sourcePath: "raw/Inbox/清单.md",
      destination: "raw/Areas/健康/清单.md", tags: ["健康", "睡眠"],
      confidence: "high", rationale: "内容明确是睡眠记录",
    });
    const snapshot = await store.snapshot();
    expect(response.path).toBe("raw/Areas/健康/清单.md");
    expect(snapshot.files["raw/Inbox/清单.md"]).toBeUndefined();
    expect(snapshot.files["raw/Areas/健康/清单.md"]).toContain('tags: ["健康", "睡眠"]');
    expect(snapshot.files["raw/Areas/索引.md"]).toContain("[[raw/Areas/健康/清单]]");
    expect(snapshot.moves).toHaveLength(1);
  });

  it("queues uncertain Inbox work without touching raw, then rejects it safely", async () => {
    const { store, service } = await fixture();
    await service.configure(config);
    const run = await service.runManual();
    const before = await store.snapshot();
    const queued = await service.applyInbox({
      runId: run.id, sourcePath: "raw/Inbox/今日.md",
      destination: "raw/Projects/生活/今日.md", tags: ["待确认"],
      confidence: "needs-confirmation", rationale: "无法区分项目与领域",
    });
    if (!("confirmation" in queued) || !queued.confirmation)
      throw new Error("低置信度分类应进入待确认队列");
    expect(await store.snapshot()).toEqual(before);
    expect(queued.confirmation.status).toBe("pending");
    const rejected = await service.decideConfirmation(queued.confirmation.id, { decision: "reject" });
    expect(rejected.confirmation.status).toBe("rejected");
    expect((await store.snapshot()).files["raw/Inbox/今日.md"]).toBeDefined();
  });

  it("blocks a planned Inbox move when the source snapshot changed", async () => {
    const { store, service } = await fixture();
    await service.configure(config);
    const run = await service.runManual();
    await store.commit({
      requestId: "inbox-source-edited", expectedRevision: run.sourceRevision,
      files: { ...(await store.snapshot()).files, "raw/Inbox/今日.md": "# 已手工更新" },
    });
    await expect(service.applyInbox({
      runId: run.id, sourcePath: "raw/Inbox/今日.md",
      destination: "raw/Areas/健康/今日.md", tags: ["健康"],
      confidence: "high", rationale: "过期计划",
    })).rejects.toBeInstanceOf(ConflictError);
    expect((await store.snapshot()).files["raw/Inbox/今日.md"]).toBe("# 已手工更新");
  });

  it("applies a planned dual-view result only to its unchanged version", async () => {
    const { store, service } = await fixture();
    await service.configure(config);
    const before = await store.snapshot();
    await store.commit({
      requestId: "dual-view-local-change", expectedRevision: before.revision,
      files: { ...before.files, "raw/Inbox/今日.md": "# 今日记录\n\n已经修改" },
    });
    const run = await service.runManual();
    expect(run.candidates.some((item) => item.capability === "dualView" && item.path === "raw/Inbox/今日")).toBe(true);
    const opml = '<?xml version="1.0"?><opml version="2.0"><head><title>今日记录</title></head><body><outline text="已同步"/></body></opml>';
    const applied = await service.applyDualView({
      runId: run.id, stem: "raw/Inbox/今日", markdown: "# 今日记录\n\n已同步",
      opml, rationale: "已按 Markdown 变化同步导图",
    });
    const snapshot = await store.snapshot();
    expect(applied.stem).toBe("raw/Inbox/今日");
    expect(snapshot.files["raw/Inbox/今日.opml"]).toBe(opml);
    expect(snapshot.files["raw/Inbox/今日.note.yaml"]).toContain("recorded_at");
  });
});
