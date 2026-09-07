import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerStaticFiles } from "../server/static-files";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("generated local preview assets", () => {
  it("streams lazy JavaScript chunks instead of serializing them as JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "risk-lab-static-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "assets"));
    await fs.writeFile(path.join(root, "assets", "AdminPanel.js"), "export default 1;");
    const app = Fastify();
    registerStaticFiles(app, root);
    const response = await app.inject("/assets/AdminPanel.js");
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/javascript");
    expect(response.body).toBe("export default 1;");
  });
});
