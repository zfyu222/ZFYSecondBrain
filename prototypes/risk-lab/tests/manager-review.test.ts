import Fastify, { type FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerVaultApi } from "../server/api";
import { FileStore } from "../server/store";

const apps: FastifyInstance[] = [];
const headers = {
  host: "127.0.0.1:4173",
  origin: "http://127.0.0.1:4173",
  "content-type": "application/json",
};

async function fixture() {
  const parent = path.resolve(".prototype-data/tests");
  await fs.mkdir(parent, { recursive: true });
  const store = new FileStore(await fs.mkdtemp(path.join(parent, "manager-")));
  await store.init(false);
  const base = await store.commit({
    requestId: "manager-seed",
    expectedRevision: (await store.snapshot()).revision,
    files: { "raw/Inbox/a.md": "# 原文" },
  });
  const app = Fastify();
  apps.push(app);
  registerVaultApi(app, store);
  return { app, store, base };
}

const proposal = (revision: string) => ({
  version: 1,
  task: "用户委托改写",
  command: "propose-change",
  paths: ["raw/Inbox/a.md"],
  authorization: "propose-change",
  proposal: {
    path: "raw/Inbox/a.md",
    baseRevision: revision,
    content: "# 已审阅改写",
    rationale: "用户明确要求改写",
  },
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("AI manager review boundary", () => {
  it("executes scoped CIL reads through HTTP with a source revision", async () => {
    const { app, base } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/cil",
      headers,
      payload: {
        version: 1,
        task: "个人知识问答",
        command: "search",
        paths: ["raw/Inbox"],
        query: "原文",
        authorization: "read",
      },
    });
    expect(response.json()).toEqual({
      sourceRevision: base.revision,
      result: {
        command: "search",
        matches: [{ path: "raw/Inbox/a.md", excerpt: "# 原文" }],
      },
    });
  });

  it("turns a CIL change command into a pending review instead of a write", async () => {
    const { app, store, base } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/cil",
      headers,
      payload: proposal(base.revision),
    });
    expect(response.json().result).toMatchObject({ status: "pending" });
    expect((await store.snapshot()).revision).toBe(base.revision);
  });

  it("accepts an answer only when its citations came from a current CIL read", async () => {
    const { app, store } = await fixture();
    const read = await app.inject({
      method: "POST",
      url: "/api/cil",
      headers,
      payload: {
        version: 1,
        task: "个人知识问答",
        command: "read",
        paths: ["raw/Inbox/a.md"],
        authorization: "read",
      },
    });
    const answer = await app.inject({
      method: "POST",
      url: "/api/manager/answers",
      headers,
      payload: {
        evidenceId: read.json().evidenceId,
        answer: "笔记的标题是原文。",
        citations: [{ path: "raw/Inbox/a.md", quote: "# 原文" }],
      },
    });
    expect(answer.json()).toMatchObject({ task: "个人知识问答" });
    await store.commit({
      requestId: "answer-source-changed",
      expectedRevision: (await store.snapshot()).revision,
      files: { "raw/Inbox/a.md": "# 新原文" },
    });
    const stale = await app.inject({
      method: "POST",
      url: "/api/manager/answers",
      headers,
      payload: {
        evidenceId: read.json().evidenceId,
        answer: "旧答案",
        citations: [{ path: "raw/Inbox/a.md", quote: "# 原文" }],
      },
    });
    expect(stale.statusCode).toBe(409);
  });

  it("rejects citations that were not returned by CIL read", async () => {
    const { app } = await fixture();
    const read = await app.inject({
      method: "POST",
      url: "/api/cil",
      headers,
      payload: {
        version: 1,
        task: "个人知识问答",
        command: "read",
        paths: ["raw/Inbox/a.md"],
        authorization: "read",
      },
    });
    const answer = await app.inject({
      method: "POST",
      url: "/api/manager/answers",
      headers,
      payload: {
        evidenceId: read.json().evidenceId,
        answer: "猜测",
        citations: [{ path: "raw/Areas/不存在.md", quote: "不存在" }],
      },
    });
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error).toContain("未读取");
  });

  it("persists a review and applies it through the versioned store", async () => {
    const { app, store, base } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/manager/reviews",
      headers,
      payload: proposal(base.revision),
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      before: "# 原文",
      after: "# 已审阅改写",
      status: "pending",
    });
    const listed = await app.inject({ url: "/api/manager/reviews", headers });
    expect(listed.json()).toHaveLength(1);
    const applied = await app.inject({
      method: "POST",
      url: `/api/manager/reviews/${created.json().id}/decision`,
      headers,
      payload: { decision: "apply" },
    });
    expect(applied.json()).toMatchObject({ status: "applied" });
    expect((await store.snapshot()).files["raw/Inbox/a.md"]).toBe(
      "# 已审阅改写",
    );
  });

  it("rejects stale proposals before review without writing", async () => {
    const { app, store, base } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/manager/reviews",
      headers,
      payload: proposal("a".repeat(64)),
    });
    expect(response.statusCode).toBe(409);
    expect((await store.snapshot()).revision).toBe(base.revision);
  });

  it("marks an accepted review stale when the source changes", async () => {
    const { app, store, base } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/manager/reviews",
      headers,
      payload: proposal(base.revision),
    });
    await store.commit({
      requestId: "user-edit-after-review",
      expectedRevision: base.revision,
      files: { "raw/Inbox/a.md": "# 用户的新版本" },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/manager/reviews/${created.json().id}/decision`,
      headers,
      payload: { decision: "apply" },
    });
    expect(response.statusCode).toBe(409);
    expect((await store.snapshot()).files["raw/Inbox/a.md"]).toBe(
      "# 用户的新版本",
    );
    const listed = await app.inject({ url: "/api/manager/reviews", headers });
    expect(listed.json()[0].status).toBe("stale");
  });

  it("records rejection and never changes raw content", async () => {
    const { app, store, base } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/manager/reviews",
      headers,
      payload: proposal(base.revision),
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/manager/reviews/${created.json().id}/decision`,
      headers,
      payload: { decision: "reject" },
    });
    expect(rejected.json().status).toBe("rejected");
    expect((await store.snapshot()).revision).toBe(base.revision);
  });

  it("exposes version-checked Inbox classification and its confirmation queue", async () => {
    const { app, store } = await fixture();
    const configured = await app.inject({
      method: "PUT", url: "/api/memory/config", headers,
      payload: { enabled: true, localTime: "03:00", capabilities: { summaries: false, inbox: true, dualView: false } },
    });
    expect(configured.statusCode).toBe(200);
    const run = await app.inject({ method: "POST", url: "/api/memory/run", headers, payload: {} });
    expect(run.statusCode, run.body).toBe(200);
    const runId = run.json().id as string;
    const queued = await app.inject({
      method: "POST", url: "/api/memory/inbox", headers,
      payload: {
        runId, sourcePath: "raw/Inbox/a.md", destination: "raw/Areas/资料/a.md",
        tags: ["资料"], confidence: "needs-confirmation", rationale: "需要用户确认",
      },
    });
    expect(queued.statusCode).toBe(200);
    expect((await store.snapshot()).files["raw/Inbox/a.md"]).toBe("# 原文");
    const accepted = await app.inject({
      method: "POST", url: `/api/memory/confirmations/${queued.json().confirmation.id}/decision`, headers,
      payload: { decision: "accept" },
    });
    expect(accepted.statusCode).toBe(200);
    expect((await store.snapshot()).files["raw/Areas/资料/a.md"]).toContain('tags: ["资料"]');
    const state = await app.inject({ method: "GET", url: "/api/memory", headers });
    const notification = state.json().notifications.find((item: { read: boolean }) => !item.read);
    const read = await app.inject({
      method: "POST", url: `/api/memory/notifications/${notification.id}/read`, headers, payload: {},
    });
    expect(read.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/memory", headers })).json().notifications
      .find((item: { id: string }) => item.id === notification.id).read).toBe(true);
  });
});
