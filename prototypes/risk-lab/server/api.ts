import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { FileStore, ConflictError, RejectedError } from "./store";
import { changeSchema, moveSchema } from "../src/core/contracts";
import { ManagerReviewService } from "./manager-review";
import { MemoryWorkflowService } from "./memory-workflow";
import { executeCilRequest, validateCilRequest } from "../src/core/cil";
import { ManagerAnswerService } from "./manager-answer";

/** Local prototype routes; tests inject requests without opening a network listener. */
export function registerVaultApi(app: FastifyInstance, store: FileStore) {
  const managerReviews = new ManagerReviewService(store);
  const managerAnswers = new ManagerAnswerService();
  const memoryWorkflow = new MemoryWorkflowService(store);
  const memoryTimer = setInterval(
    () => void memoryWorkflow.runDue().catch((error) => void memoryWorkflow.recordFailure(error)),
    60_000,
  );
  memoryTimer.unref();
  app.addHook("onClose", () => clearInterval(memoryTimer));
  app.addHook("onRequest", async (request, reply) => {
    if (
      !["127.0.0.1:4173", "localhost:4173"].includes(request.headers.host ?? "")
    )
      return reply.code(403).send({ error: "仅允许本机原型访问" });
    const origin = request.headers.origin;
    if (
      origin &&
      !["http://127.0.0.1:4173", "http://localhost:4173"].includes(origin)
    )
      return reply.code(403).send({ error: "拒绝跨站请求" });
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
  app.post<{ Params: { id: string } }>(
    "/api/manager/reviews/:id/decision",
    (request) => managerReviews.decide(request.params.id, request.body),
  );
  app.get("/api/memory", () => memoryWorkflow.getState());
  app.put("/api/memory/config", (request) =>
    memoryWorkflow.configure(request.body),
  );
  app.post("/api/memory/run", () => memoryWorkflow.runManual());
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
    storage: ".prototype-data/server",
  }));
}
