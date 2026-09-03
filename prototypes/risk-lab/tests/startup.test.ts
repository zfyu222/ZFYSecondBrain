import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalServer } from "../server/startup";

const apps: FastifyInstance[] = [];
function fixture() {
  const app = Fastify();
  apps.push(app);
  app.get("/api/test", () => ({ ready: true }));
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe("local service startup ordering", () => {
  it("binds the port before running initialization and opens routes only after completion", async () => {
    const app = fixture();
    const initialize = vi.fn(async () => {
      expect(app.server.listening).toBe(true);
      const response = await app.inject({ url: "/api/test" });
      expect(response.statusCode).toBe(503);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json().ready).toBeUndefined();
    });
    await startLocalServer(app, initialize, 0);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url: "/api/test" })).json()).toEqual({
      ready: true,
    });
  });
  it("never initializes or recovers a second service when its port is occupied", async () => {
    const first = fixture();
    await startLocalServer(first, async () => {}, 0);
    const port = (first.server.address() as { port: number }).port;
    const second = fixture(),
      initialize = vi.fn(async () => {}),
      closed = vi.fn();
    second.addHook("onClose", async () => {
      closed();
    });
    await expect(
      startLocalServer(second, initialize, port),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(initialize).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
    expect((await first.inject({ url: "/api/test" })).statusCode).toBe(200);
  });
  it("closes listeners and resources when initialization fails", async () => {
    const app = fixture(),
      closed = vi.fn();
    app.addHook("onClose", async () => {
      closed();
    });
    let port = 0;
    await expect(
      startLocalServer(
        app,
        async () => {
          port = (app.server.address() as { port: number }).port;
          throw new Error("initialization failed without serving notes");
        },
        0,
      ),
    ).rejects.toThrow("initialization failed");
    expect(app.server.listening).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    const next = fixture();
    await startLocalServer(next, async () => {}, port);
    expect((await next.inject({ url: "/api/test" })).statusCode).toBe(200);
  });
});
