import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DeepSeekManager, deepSeekConfigFromEnvironment } from "../server/deepseek-manager";
import { ManagerAnswerService } from "../server/manager-answer";
import { FileStore } from "../server/store";
import { MemoryWorkflowService } from "../server/memory-workflow";

const snapshot = {
  revision: "a".repeat(64),
  files: {
    "raw/Inbox/evidence.md": "# 项目状态\n\n本周完成本地验证。",
    "raw/Archive/private.md": "不得发送",
  },
};

describe("DeepSeek manager boundary", () => {
  it("uses only CIL-returned evidence and validates model citations before returning", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answer: "本周完成本地验证。",
        citations: [{ path: "raw/Inbox/evidence.md", quote: "本周完成本地验证。" }],
      }) } }],
    })));
    const manager = new DeepSeekManager({ apiKey: "test-key", baseUrl: "https://model.example", model: "test-model", thinking: "disabled" }, fetcher);
    const answer = await manager.ask({ question: "项目状态" }, snapshot, new ManagerAnswerService());
    expect(answer).toMatchObject({ sourceRevision: snapshot.revision, task: "个人知识问答" });
    expect(fetcher).toHaveBeenCalledWith("https://model.example/chat/completions", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(JSON.stringify(body)).toContain("raw/Inbox/evidence.md");
    expect(JSON.stringify(body)).not.toContain("不得发送");
  });

  it("rejects a model citation that does not come from the read evidence", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        answer: "错误引用",
        citations: [{ path: "raw/Archive/private.md", quote: "不得发送" }],
      }) } }],
    })));
    const manager = new DeepSeekManager({ apiKey: "test-key", baseUrl: "https://model.example/", model: "test-model", thinking: "disabled" }, fetcher);
    await expect(manager.ask({ question: "项目状态" }, snapshot, new ManagerAnswerService())).rejects.toThrow("未读取");
  });

  it("keeps credentials configurable only through server environment", () => {
    expect(deepSeekConfigFromEnvironment({})).toEqual({
      apiKey: undefined, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", thinking: "disabled",
    });
  });

  it("advances an authorized memory plan between model-owned summary and Inbox steps", async () => {
    const parent = path.resolve(".prototype-data/tests");
    await fs.mkdir(parent, { recursive: true });
    const store = new FileStore(await fs.mkdtemp(path.join(parent, "deepseek-memory-")));
    await store.init(false);
    const content = "内容".repeat(300);
    await store.commit({
      requestId: "deepseek-memory-seed", expectedRevision: (await store.snapshot()).revision,
      files: { "raw/Inbox/整理.md": content },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ destination: "raw/Areas/资料/整理.md", tags: ["资料"], confidence: "high", rationale: "内容明确" }) } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ layers: ["短", "内容".repeat(20)] }) } }] })));
    const manager = new DeepSeekManager({ apiKey: "test-key", baseUrl: "https://model.example", model: "test-model", thinking: "disabled" }, fetcher);
    const workflow = new MemoryWorkflowService(store);
    await workflow.configure({ enabled: true, localTime: "03:00", capabilities: { summaries: true, inbox: true, dualView: false } });
    const run = await workflow.runManual();
    const result = await manager.executeMemoryRun(run.id, workflow, () => store.snapshot());
    expect(result.run.status).toBe("completed");
    expect(result.completed).toEqual(["inbox:raw/Inbox/整理.md", "summaries:raw/Areas/资料/整理.md"]);
    const after = await store.snapshot();
    expect(after.files["derived/summaries/Areas/资料/整理.summary.yaml"]).toContain("source: ai");
    expect(after.files["raw/Areas/资料/整理.md"]).toContain("内容");
    expect(after.files["raw/Inbox/整理.md"]).toBeUndefined();
  });

  it("falls back to a validated single summary layer when the model cannot satisfy a multi-layer ratio", async () => {
    const parent = path.resolve(".prototype-data/tests");
    await fs.mkdir(parent, { recursive: true });
    const store = new FileStore(await fs.mkdtemp(path.join(parent, "deepseek-summary-fallback-")));
    await store.init(false);
    await store.commit({
      requestId: "deepseek-summary-fallback-seed", expectedRevision: (await store.snapshot()).revision,
      files: { "raw/Areas/摘要.md": "内容".repeat(200) },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ layers: ["摘要", "过短"] }) } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ layers: ["一", "二", "三"] }) } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ layers: ["本地验收"] }) } }] })));
    const manager = new DeepSeekManager({ apiKey: "test-key", baseUrl: "https://model.example", model: "test-model", thinking: "disabled" }, fetcher);
    const workflow = new MemoryWorkflowService(store);
    await workflow.configure({ enabled: true, localTime: "03:00", capabilities: { summaries: true, inbox: false, dualView: false } });
    const run = await workflow.runManual();
    await manager.executeMemoryRun(run.id, workflow, () => store.snapshot());
    expect((await store.snapshot()).files["derived/summaries/Areas/摘要.summary.yaml"]).toContain("本地验收");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
