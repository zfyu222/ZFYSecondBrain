import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { SingleAccountAuth } from "../server/auth";
import { FileStore } from "../server/store";
import { registerVaultApi } from "../server/api";

describe("single-account authentication boundary", () => {
  it("persists only a salted verifier and grants a revocable session", async () => {
    const parent = path.resolve(".prototype-data/tests");
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "auth-"));
    await fs.mkdir(path.join(root, "state"));
    const auth = new SingleAccountAuth(root, "correct horse battery staple");
    expect(await auth.login("wrong")).toBeUndefined();
    const token = await auth.login("correct horse battery staple");
    expect(token).toBeTypeOf("string");
    expect(await auth.authorized(`zfy_session=${token}`)).toBe(true);
    const saved = await fs.readFile(path.join(root, "state", "auth.json"), "utf8");
    expect(saved).not.toContain("correct horse battery staple");
    auth.logout(`zfy_session=${token}`);
    expect(await auth.authorized(`zfy_session=${token}`)).toBe(false);
  });
  it("requires the session before exposing a protected API", async () => {
    const parent = path.resolve(".prototype-data/tests");
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "auth-api-"));
    const store = new FileStore(root);
    await store.init(false);
    const app = Fastify();
    registerVaultApi(app, store, new SingleAccountAuth(root, "password"));
    const headers = { host: "127.0.0.1:4173", origin: "http://127.0.0.1:4173" };
    const session = await app.inject({ url: "/api/auth/session", headers });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ authenticated: false });
    expect((await app.inject({ url: "/api/snapshot", headers })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { password: "password" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"]!;
    expect(
      (await app.inject({ url: "/api/auth/session", headers: { ...headers, cookie } })).json(),
    ).toEqual({ authenticated: true });
    expect((await app.inject({ url: "/api/snapshot", headers: { ...headers, cookie } })).statusCode).toBe(200);
    await app.close();
  });
});
