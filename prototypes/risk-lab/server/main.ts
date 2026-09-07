import Fastify from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "./store";
import { registerVaultApi } from "./api";
import { startLocalServer } from "./startup";
import { registerStaticFiles } from "./static-files";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const store = new FileStore(path.join(appRoot, ".prototype-data", "server"));
const app = Fastify({ logger: false, bodyLimit: 12_000_000 });
registerVaultApi(app, store);
if (process.argv.includes("--production")) {
  registerStaticFiles(app, path.join(appRoot, "dist"));
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
await startLocalServer(app, () => store.init());
console.log(
  "Local: http://127.0.0.1:4173/ — isolated risk prototype, not a production server",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
