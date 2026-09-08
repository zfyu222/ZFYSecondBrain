import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = path.resolve("../..");

describe("self-hosted deployment files", () => {
  it("keeps knowledge data persistent and publishes only to a local reverse proxy", async () => {
    const compose = parse(await readFile(path.join(root, "compose.yaml"), "utf8")) as {
      services: { "zfy-second-brain": { ports: string[]; volumes: string[]; environment: Record<string, string> } };
    };
    const service = compose.services["zfy-second-brain"];
    expect(service.ports).toEqual(["127.0.0.1:4173:4173"]);
    expect(service.volumes[0]).toContain(".prototype-data/server");
    expect(service.environment.ZFY_PUBLIC_ORIGIN).toContain("ZFY_PUBLIC_ORIGIN");
    expect(service.environment.ZFY_AUTH_PASSWORD).toContain("ZFY_AUTH_PASSWORD");
  });

  it("builds the current workspace and never copies local data into the image", async () => {
    const dockerfile = await readFile(path.join(root, "prototypes/risk-lab/Dockerfile"), "utf8");
    const ignore = await readFile(path.join(root, ".dockerignore"), "utf8");
    expect(dockerfile).toContain("pnpm --filter @zfy/risk-lab build");
    expect(dockerfile).toContain('CMD ["pnpm", "--filter", "@zfy/risk-lab", "start"]');
    expect(ignore).toContain(".prototype-data");
    expect(ignore).toContain("node_modules");
  });
});
