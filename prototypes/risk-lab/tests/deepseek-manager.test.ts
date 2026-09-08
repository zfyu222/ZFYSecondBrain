import { describe, expect, it, vi } from "vitest";
import { DeepSeekManager, deepSeekConfigFromEnvironment } from "../server/deepseek-manager";
import { ManagerAnswerService } from "../server/manager-answer";

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
    const manager = new DeepSeekManager({ apiKey: "test-key", baseUrl: "https://model.example", model: "test-model" }, fetcher);
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
    const manager = new DeepSeekManager({ apiKey: "test-key", baseUrl: "https://model.example/", model: "test-model" }, fetcher);
    await expect(manager.ask({ question: "项目状态" }, snapshot, new ManagerAnswerService())).rejects.toThrow("未读取");
  });

  it("keeps credentials configurable only through server environment", () => {
    expect(deepSeekConfigFromEnvironment({})).toEqual({
      apiKey: undefined, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash",
    });
  });
});
