import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { offlineAssets, offlineShell } from "../server/offline-shell";

const origin = "http://127.0.0.1:4173",
  version = "risk-lab-current",
  shell = `offline-shell-${"a".repeat(64)}.html`;
const names = [
  shell,
  "assets/index.js",
  "assets/MarkdownEditor.js",
  "assets/MapEditor.js",
  "assets/MapEditor.css",
];
function worker(failInstall = false) {
  const listeners = new Map<string, (event: unknown) => void>();
  const storage = new Map<string, Map<string, unknown>>();
  const keyOf = (input: string | { url: string }) =>
    new URL(typeof input === "string" ? input : input.url, origin).href;
  const caches = {
    open: async (name: string) => {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name)!;
      return {
        addAll: async (paths: string[]) => {
          if (failInstall) throw new Error("CACHE_FULL");
          for (const p of paths) entries.set(keyOf(p), { ok: true, cached: p });
        },
        match: async (input: string | { url: string }) =>
          entries.get(keyOf(input)),
      };
    },
    keys: async () => [...storage.keys()],
    delete: async (name: string) => storage.delete(name),
  };
  const fetch = vi.fn(async (_request: unknown) => ({
    ok: true,
    network: true,
  }));
  const self = {
    location: { origin },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  runInNewContext(
    offlineShell(version, offlineAssets(names)),
    { self, caches, fetch, URL, Response },
    { timeout: 1000 },
  );
  const lifecycle = async (type: string) => {
    let pending: Promise<unknown> | undefined;
    listeners.get(type)!({
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    return pending;
  };
  const request = async (url: string, method = "GET", mode = "cors") => {
    let response: Promise<unknown> | undefined;
    listeners.get("fetch")!({
      request: { url: new URL(url, origin).href, method, mode },
      respondWith: (promise: Promise<unknown>) => {
        response = promise;
      },
    });
    return response;
  };
  return { storage, caches, fetch, self, lifecycle, request };
}
describe("offline shell and lazy editor cache", () => {
  it("includes every generated editor chunk and stylesheet, excludes maps and the worker itself", () => {
    expect(
      offlineAssets([
        ...names,
        "assets/index.js",
        "assets/index.js.map",
        "index.html",
        "sw.js",
      ]),
    ).toEqual([
      "/assets/MapEditor.css",
      "/assets/MapEditor.js",
      "/assets/MarkdownEditor.js",
      "/assets/index.js",
      "/" + shell,
    ]);
  });
  it("preloads both editors and serves them from cache without a network call", async () => {
    const test = worker();
    await test.lifecycle("install");
    expect(test.self.skipWaiting).not.toHaveBeenCalled();
    for (const file of names)
      expect(await test.request("/" + file)).toEqual({
        ok: true,
        cached: "/" + file,
      });
    expect(test.fetch).not.toHaveBeenCalled();
  });
  it("does not announce successful installation when caching fails", async () => {
    const test = worker(true);
    await expect(test.lifecycle("install")).rejects.toThrow("CACHE_FULL");
    expect(test.self.skipWaiting).not.toHaveBeenCalled();
  });
  it("pins navigations to the installed shell without asking for a newer network entry", async () => {
    const test = worker();
    await test.lifecycle("install");
    test.fetch.mockRejectedValueOnce(new Error("OFFLINE"));
    expect(await test.request("/", "GET", "navigate")).toEqual({
      ok: true,
      cached: "/" + shell,
    });
    expect(test.fetch).not.toHaveBeenCalled();
    expect(await test.request("/?another-tab", "GET", "navigate")).toEqual({
      ok: true,
      cached: "/" + shell,
    });
  });
  it("only fetches the same immutable entry if the shell was evicted", async () => {
    const test = worker();
    await test.lifecycle("install");
    test.storage.get(version)!.delete(origin + "/" + shell);
    expect(await test.request("/", "GET", "navigate")).toEqual({
      ok: true,
      network: true,
    });
    expect(test.fetch).toHaveBeenCalledWith("/" + shell);
  });
  it.each(["http", "network"])(
    "does not mix in a new root entry after a %s failure",
    async (failure) => {
      const test = worker();
      await test.lifecycle("install");
      test.storage.get(version)!.delete(origin + "/" + shell);
      if (failure === "http")
        test.fetch.mockResolvedValueOnce({ ok: false, network: true });
      else test.fetch.mockRejectedValueOnce(new Error("OFFLINE"));
      const response = (await test.request("/", "GET", "navigate")) as Response;
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("不要清除浏览器数据");
      expect(test.fetch).toHaveBeenCalledExactlyOnceWith("/" + shell);
    },
  );
  it("does not delete an active version's assets during installation", async () => {
    const test = worker();
    await test.caches.open("risk-lab-old");
    await test.lifecycle("install");
    expect(test.storage.has("risk-lab-old")).toBe(true);
    expect(test.self.skipWaiting).not.toHaveBeenCalled();
    expect(test.self.clients.claim).not.toHaveBeenCalled();
  });
  it("rejects absent or ambiguous immutable entries", () => {
    expect(() => offlineShell(version, ["/"])).toThrow("唯一");
    expect(() =>
      offlineShell(version, ["/" + shell, `/offline-shell-${"b".repeat(64)}.html`]),
    ).toThrow("唯一");
  });
  it("never intercepts API calls, mutations, external origins or unknown resources", async () => {
    const test = worker();
    await test.lifecycle("install");
    expect(await test.request("/api/snapshot")).toBeUndefined();
    expect(await test.request("/api/commit", "POST")).toBeUndefined();
    expect(await test.request("/assets/index.js", "POST")).toBeUndefined();
    expect(
      await test.request("https://example.org/assets/index.js"),
    ).toBeUndefined();
    expect(await test.request("/raw/Inbox/private.md")).toBeUndefined();
    expect(test.fetch).not.toHaveBeenCalled();
  });
  it("removes only older prototype caches when activating", async () => {
    const test = worker();
    await test.caches.open("risk-lab-old");
    await test.caches.open("another-application");
    await test.lifecycle("install");
    await test.lifecycle("activate");
    expect([...test.storage.keys()].sort()).toEqual([
      "another-application",
      version,
    ]);
    expect(test.self.clients.claim).not.toHaveBeenCalled();
  });
});
