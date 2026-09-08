import Fastify from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore } from "./store";
import { registerVaultApi } from "./api";
import { startLocalServer } from "./startup";
import { registerStaticFiles } from "./static-files";
import { accessControlFromEnvironment } from "./access-control";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
try {
  process.loadEnvFile(path.join(appRoot, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const store = new FileStore(path.join(appRoot, ".prototype-data", "server"));
const app = Fastify({ logger: false, bodyLimit: 12_000_000 });
const access = accessControlFromEnvironment();
registerVaultApi(app, store, undefined, access);
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
await startLocalServer(app, () => store.init(), 4173, access.listenHost);
console.log(
  `${access.listenHost === "127.0.0.1" ? "Local: http://127.0.0.1:4173" : "Public origin: " + access.origins[0]} — isolated risk prototype, not a production server`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
