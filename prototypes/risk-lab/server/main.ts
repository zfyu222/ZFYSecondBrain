import Fastify from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore, ConflictError, RejectedError } from "./store";
import { ZodError } from "zod";
import { changeSchema, moveSchema } from "../src/core/contracts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const store = new FileStore(path.join(appRoot, ".prototype-data", "server"));
await store.init();
const app = Fastify({ logger: false, bodyLimit: 12_000_000 });
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
  return reply
    .code(
      error instanceof ZodError || error instanceof RejectedError ? 400 : 500,
    )
    .send({ error: error instanceof Error ? error.message : "操作失败" });
});
app.get("/api/snapshot", () => store.snapshot());
app.post("/api/commit", (request) =>
  store.commit(changeSchema.parse(request.body)),
);
app.post("/api/move", (request) => store.move(moveSchema.parse(request.body)));
app.get("/api/health", () => ({
  prototype: true,
  ai: false,
  storage: ".prototype-data/server",
}));
if (process.argv.includes("--production")) {
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
  };
  app.get("/*", async (request, reply) => {
    const urlPath = new URL(request.url, "http://localhost").pathname;
    const rel =
      urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).slice(1);
    const dist = path.join(appRoot, "dist"),
      file = path.resolve(dist, rel);
    if (!file.startsWith(dist + path.sep)) return reply.code(403).send();
    try {
      return reply
        .header("Cache-Control", "no-cache")
        .type(mime[path.extname(file)] ?? "application/octet-stream")
        .send(await fs.readFile(file));
    } catch {
      return reply.code(404).send({ error: "资源不存在" });
    }
  });
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: appRoot,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.get("/*", async (request, reply) => {
    reply.hijack();
    vite.middlewares(request.raw, reply.raw);
  });
  app.addHook("onClose", () => vite.close());
}
await app.listen({ host: "127.0.0.1", port: 4173 });
console.log(
  "Local: http://127.0.0.1:4173/ — isolated risk prototype, not a production server",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
