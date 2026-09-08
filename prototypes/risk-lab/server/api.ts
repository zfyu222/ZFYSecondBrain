import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { FileStore, ConflictError, RejectedError } from "./store";
import { changeSchema, moveSchema } from "../src/core/contracts";
import { ManagerReviewService } from "./manager-review";
import { MemoryWorkflowService } from "./memory-workflow";
import { executeCilRequest, validateCilRequest } from "../src/core/cil";
import { ManagerAnswerService } from "./manager-answer";
import { DeepSeekManager, deepSeekConfigFromEnvironment } from "./deepseek-manager";
import { SingleAccountAuth } from "./auth";
import type { AccessControl } from "./access-control";

const localAccess: AccessControl = {
  hosts: ["127.0.0.1:4173", "localhost:4173"],
  origins: ["http://127.0.0.1:4173", "http://localhost:4173"],
  listenHost: "127.0.0.1",
};

/** Local prototype routes; tests inject requests without opening a network listener. */
export function registerVaultApi(
  app: FastifyInstance,
  store: FileStore,
  auth = new SingleAccountAuth(store.root),
  access: AccessControl = localAccess,
) {
  const managerReviews = new ManagerReviewService(store);
  const managerAnswers = new ManagerAnswerService();
  const deepSeekManager = new DeepSeekManager();
  const memoryWorkflow = new MemoryWorkflowService(store);
  const runDueMemory = async () => {
    const run = await memoryWorkflow.runDue();
    if (run?.status === "awaiting-manager")
      await deepSeekManager.executeMemoryRun(run.id, memoryWorkflow, () => store.snapshot());
  };
  const memoryTimer = setInterval(
    () => void runDueMemory().catch((error) => void memoryWorkflow.recordFailure(error)),
    60_000,
  );
  memoryTimer.unref();
  app.addHook("onClose", () => clearInterval(memoryTimer));
  app.addHook("onRequest", async (request, reply) => {
    if (
      !access.hosts.includes(request.headers.host ?? "")
    )
      return reply.code(403).send({ error: "仅允许本机原型访问" });
    const origin = request.headers.origin;
    if (
      origin &&
      !access.origins.includes(origin)
    )
      return reply.code(403).send({ error: "拒绝跨站请求" });
    const route = request.url.split("?")[0];
    if (
      auth.enabled &&
      route.startsWith("/api/") &&
      !["/api/auth/login", "/api/auth/session", "/api/health"].includes(route) &&
      !(await auth.authorized(request.headers.cookie))
    )
      return reply.code(401).send({ error: "需要登录" });
  });
  app.get("/api/auth/session", async (request) => ({ authenticated: await auth.authorized(request.headers.cookie) }));
  app.post("/api/auth/login", async (request, reply) => {
    const password = request.body && typeof request.body === "object" && "password" in request.body
      ? (request.body as { password?: unknown }).password : undefined;
    const token = await auth.login(password);
    if (!token) return reply.code(401).send({ error: "账号或密码错误" });
    return reply.header("Set-Cookie", `zfy_session=${token}; HttpOnly; SameSite=Strict; Path=/`).send({ authenticated: true });
  });
  app.post("/api/auth/logout", (request, reply) => {
    auth.logout(request.headers.cookie);
    return reply.header("Set-Cookie", "zfy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0").send({ authenticated: false });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConflictError)
      return reply
        .code(409)
        .send({ error: error.message, snapshot: error.snapshot });
    const status =
      error instanceof ZodError || error instanceof RejectedError
        ? 400
        : error &&
            typeof error === "object" &&
            "statusCode" in error &&
            [400, 413, 415].includes(Number(error.statusCode))
          ? Number(error.statusCode)
          : 500;
    return reply
      .code(status)
      .send({ error: error instanceof Error ? error.message : "操作失败" });
  });
  app.get("/api/snapshot", async (request, reply) => {
    const snapshot = await store.snapshot();
    if (snapshot.attachments && request.headers["x-vault-protocol"] !== "2")
      return reply.code(426).send({ error: "知识库包含附件，请升级客户端" });
    return reply.header("Cache-Control", "no-store").send(snapshot);
  });
  app.post("/api/commit", (request) =>
    store.commit(changeSchema.parse(request.body)),
  );
  app.post("/api/move", (request) =>
    store.move(moveSchema.parse(request.body)),
  );
  app.get("/api/manager/reviews", () => managerReviews.list());
  app.post("/api/manager/reviews", (request) =>
    managerReviews.create(request.body),
  );
  app.post("/api/cil", async (request) => {
    const command = validateCilRequest(request.body);
    if (command.command === "propose-change")
      return { result: await managerReviews.create(command) };
    const snapshot = await store.snapshot();
    const result = executeCilRequest(command, snapshot.files);
    const evidenceId = managerAnswers.record(command, snapshot.revision, result);
    return {
      sourceRevision: snapshot.revision,
      ...(evidenceId ? { evidenceId } : {}),
      result,
    };
  });
  app.post("/api/manager/answers", async (request) =>
    managerAnswers.submit(request.body, await store.snapshot()),
  );
  app.post("/api/manager/ask", async (request) =>
    deepSeekManager.ask(request.body, await store.snapshot(), managerAnswers),
  );
  app.post<{ Params: { id: string } }>(
    "/api/manager/reviews/:id/decision",
    (request) => managerReviews.decide(request.params.id, request.body),
  );
  app.get("/api/memory", () => memoryWorkflow.getState());
  app.put("/api/memory/config", (request) =>
    memoryWorkflow.configure(request.body),
  );
  app.post("/api/memory/run", () => memoryWorkflow.runManual());
  app.post<{ Params: { id: string } }>("/api/memory/runs/:id/execute", (request) =>
    deepSeekManager.executeMemoryRun(request.params.id, memoryWorkflow, () => store.snapshot()),
  );
  app.post("/api/memory/summaries", (request) =>
    memoryWorkflow.applySummary(request.body),
  );
  app.post("/api/memory/inbox", (request) =>
    memoryWorkflow.applyInbox(request.body),
  );
  app.post("/api/memory/dual-view", (request) =>
    memoryWorkflow.applyDualView(request.body),
  );
  app.post<{ Params: { id: string } }>(
    "/api/memory/confirmations/:id/decision",
    (request) => memoryWorkflow.decideConfirmation(request.params.id, request.body),
  );
  app.post<{ Params: { id: string } }>(
    "/api/memory/notifications/:id/read",
    (request) => memoryWorkflow.markNotificationRead(request.params.id),
  );
  app.get("/api/health", () => ({
    prototype: true,
    protocolVersion: 2,
    ai: false,
    aiConfigured: Boolean(deepSeekConfigFromEnvironment().apiKey),
    storage: ".prototype-data/server",
  }));
}
