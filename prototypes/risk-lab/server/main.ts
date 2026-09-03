import Fastify from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "./store";
import { registerVaultApi } from "./api";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const store = new FileStore(path.join(appRoot, ".prototype-data", "server"));
await store.init();
const app = Fastify({ logger: false, bodyLimit: 12_000_000 });
registerVaultApi(app, store);
if (process.argv.includes("--production")) {
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
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
