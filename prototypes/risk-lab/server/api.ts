import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { FileStore, ConflictError, RejectedError } from "./store";
import { changeSchema, moveSchema } from "../src/core/contracts";

/** Local prototype routes; tests inject requests without opening a network listener. */
export function registerVaultApi(app: FastifyInstance, store: FileStore) {
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
  app.get("/api/health", () => ({
    prototype: true,
    protocolVersion: 2,
    ai: false,
    storage: ".prototype-data/server",
  }));
}
