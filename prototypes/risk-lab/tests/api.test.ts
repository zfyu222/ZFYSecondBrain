import Fastify, { type FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerVaultApi } from "../server/api";
import { FileStore } from "../server/store";
import { encodeAttachment } from "../src/core/attachments";
const apps: FastifyInstance[] = [];
const headers = {
  host: "127.0.0.1:4173",
  origin: "http://127.0.0.1:4173",
  "content-type": "application/json",
};
const note = "raw/Inbox/a.md",
  asset = "raw/Inbox/a.assets/p.png";
async function fixture(bodyLimit = 12_000_000) {
  const parent = path.resolve(".prototype-data/tests");
  await fs.mkdir(parent, { recursive: true });
  const store = new FileStore(await fs.mkdtemp(path.join(parent, "api-")));
  await store.init(false);
  const base = await store.commit({
    protocolVersion: 2,
    requestId: "api-seed",
    expectedRevision: (await store.snapshot()).revision,
    files: { [note]: "# A" },
    attachments: { [asset]: encodeAttachment(new Uint8Array([255, 0])) },
  });
  const app = Fastify({ bodyLimit });
  apps.push(app);
  registerVaultApi(app, store);
  return { app, store, base };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
describe("local protocol boundary", () => {
  it("requires binary capability before returning attachment snapshots", async () => {
    const { app, base } = await fixture();
    const old = await app.inject({ url: "/api/snapshot", headers });
    expect(old.statusCode).toBe(426);
    expect(old.json().attachments).toBeUndefined();
    const current = await app.inject({
      url: "/api/snapshot",
      headers: { ...headers, "x-vault-protocol": "2" },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual(base);
    expect(current.headers["cache-control"]).toBe("no-store");
  });
  it("rejects old or future writes without discarding binary originals", async () => {
    const { app, store, base } = await fixture();
    for (const protocolVersion of [undefined, 99]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/commit",
        headers,
        payload: {
          protocolVersion,
          requestId: "old-request",
          expectedRevision: base.revision,
          files: base.files,
        },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await store.snapshot()).toEqual(base);
  });
  it("uses a definitive rejection for occupied attachment move destinations", async () => {
    const { app, store, base } = await fixture();
    const seeded = await store.commit({
      protocolVersion: 2,
      requestId: "collision-seed",
      expectedRevision: base.revision,
      files: base.files,
      attachments: {
        ...base.attachments,
        "raw/Areas/b.assets/p.png": encodeAttachment(new Uint8Array([3])),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/move",
      headers,
      payload: {
        protocolVersion: 2,
        requestId: "collision-move",
        expectedRevision: seeded.revision,
        from: note,
        to: "raw/Areas/b.md",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(await store.snapshot()).toEqual(seeded);
  });
  it("refuses foreign hosts and origins before exposing notes", async () => {
    const { app } = await fixture();
    for (const override of [
      { host: "evil.example" },
      { origin: "https://evil.example" },
    ]) {
      const response = await app.inject({
        url: "/api/snapshot",
        headers: { ...headers, ...override, "x-vault-protocol": "2" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().files).toBeUndefined();
    }
  });
  it("retains body-limit and malformed-JSON status codes without a partial commit", async () => {
    const { app, store, base } = await fixture(128);
    const large = await app.inject({
      method: "POST",
      url: "/api/commit",
      headers,
      payload: JSON.stringify({ data: "a".repeat(256) }),
    });
    expect(large.statusCode).toBe(413);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/commit",
      headers,
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);
    expect(await store.snapshot()).toEqual(base);
  });
});
