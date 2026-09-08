import path from "node:path";
import { describe, expect, it } from "vitest";
import { serverRuntimeConfig } from "../server/runtime-config";

const appRoot = path.resolve(".prototype-data/runtime-config-app");

describe("local server runtime configuration", () => {
  it("keeps the normal loopback prototype data directory and port by default", () => {
    expect(serverRuntimeConfig({}, appRoot)).toEqual({
      dataDir: path.join(appRoot, ".prototype-data", "server"),
      port: 4173,
    });
  });
  it("allows an explicit isolated absolute directory and bounded test port", () => {
    const dataDir = path.resolve(".prototype-data/browser-isolated");
    expect(serverRuntimeConfig({ ZFY_DATA_DIR: dataDir, ZFY_PORT: "48173" }, appRoot)).toEqual({
      dataDir,
      port: 48173,
    });
  });
  it("refuses relative or root data paths and unsafe ports", () => {
    expect(() => serverRuntimeConfig({ ZFY_DATA_DIR: "relative" }, appRoot)).toThrow("绝对路径");
    expect(() => serverRuntimeConfig({ ZFY_DATA_DIR: path.parse(appRoot).root }, appRoot)).toThrow("根目录");
    for (const ZFY_PORT of ["", "1023", "65536", "not-a-port"])
      expect(() => serverRuntimeConfig({ ZFY_PORT }, appRoot)).toThrow("ZFY_PORT");
  });
});
