import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

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

/** Serve a generated local preview without treating binary assets as JSON. */
export function registerStaticFiles(app: FastifyInstance, dist: string) {
  app.get("/*", async (request, reply) => {
    const urlPath = new URL(request.url, "http://localhost").pathname;
    const relative =
      urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).slice(1);
    const file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep)) return reply.code(403).send();
    try {
      await fs.access(file);
      return reply
        .header("Cache-Control", "no-cache")
        .type(mime[path.extname(file)] ?? "application/octet-stream")
        .send(createReadStream(file));
    } catch {
      return reply.code(404).send({ error: "资源不存在" });
    }
  });
}
