import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";
import config from "../vite.config";

it("keeps development watching outside runtime fixtures and cyclic links", async () => {
  const base = path.resolve(".prototype-data/tests");
  await fs.mkdir(base, { recursive: true });
  const root = path.resolve(".");
  const runtime = await fs.mkdtemp(path.join(base, "watcher-"));
  await fs.symlink(
    runtime,
    path.join(runtime, "loop"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const server = await createServer({
    ...config,
    configFile: false,
    root,
    appType: "custom",
    server: { ...config.server, middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: "silent",
  });
  const errors: unknown[] = [];
  server.watcher.on("error", (error) => errors.push(error));
  try {
    // Explicitly asking the watcher to add fixtures must not re-enable recursion.
    server.watcher.add(runtime);
    await vi.waitFor(
      () => {
        const watched = server.watcher.getWatched();
        const project = Object.entries(watched).find(
          ([directory]) => path.normalize(directory) === root,
        );
        expect(project?.[1]).toContain("vite.config.ts");
        expect(server.watcher.options.followSymlinks).toBe(false);
        expect(server.watcher.options.ignored).toContain(
          "**/.prototype-data/**",
        );
      },
      { timeout: 5000 },
    );
    expect(errors).toEqual([]);
    const watched = Object.keys(server.watcher.getWatched());
    expect(
      watched.some((p) =>
        p.replaceAll("\\", "/").includes("/.prototype-data/"),
      ),
    ).toBe(false);
  } finally {
    await server.close();
  }
}, 15000);
