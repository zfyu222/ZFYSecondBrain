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
      "raw/Areas/健康.md": "# 健康",
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
    expect(candidates.filter((item) => item.capability === "summaries")).toHaveLength(2);
    expect(candidates.filter((item) => item.capability === "inbox")).toHaveLength(1);
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
});
