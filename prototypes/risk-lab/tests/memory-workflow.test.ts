import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordDualView } from "../src/core/dual-view";
import { FileStore } from "../server/store";
import {
  MemoryWorkflowService,
  planMemoryRun,
  type MemoryConfig,
} from "../server/memory-workflow";

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
  const md = "# 今日记录\n\n内容";
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
