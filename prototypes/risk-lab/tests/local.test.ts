import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalVault,
  moveDocument,
  readEmergencyExport,
  recentDocuments,
  rememberRecent,
  restoreEmergencyExport,
  resolveConflicts,
  synchronize,
} from "../src/local";
import { conflictOptions, mergeFiles } from "../src/core/merge";
import { serializeOpml, serializeRelations, topic } from "../src/core/formats";
const p = "raw/Inbox/a.md";
const databases: LocalVault[] = [];
async function fixture() {
  const db = new LocalVault("test-" + crypto.randomUUID());
  databases.push(db);
  const row = await db.read();
  await db.update(row.version, (r) => ({
    ...r,
    files: { [p]: "base" },
    base: { revision: "base", files: { [p]: "base" } },
  }));
  return db;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) {
    db.close();
    await db.delete();
  }
});
describe("local persistence and sync queue", () => {
  it("reopens saved data and rejects stale tabs", async () => {
    const db = await fixture(),
      row = await db.read();
    await db.update(row.version, (r) => ({ ...r, files: { [p]: "offline" } }));
    await expect(db.update(row.version, (r) => r)).rejects.toThrow("标签页");
    db.close();
    await db.open();
    expect((await db.read()).files[p]).toBe("offline");
  });
  it("records readable recent document paths in newest-first order", async () => {
    const db = await fixture();
    const first = await rememberRecent(
      db,
      (await db.read()).version,
      "raw/Inbox/a",
      "2026-09-03T01:00:00.000Z",
    );
    const second = await rememberRecent(
      db,
      first.version,
      "raw/Areas/b",
      "2026-09-03T02:00:00.000Z",
    );
    expect(recentDocuments(second)).toEqual(["raw/Areas/b", "raw/Inbox/a"]);
    await expect(
      rememberRecent(db, second.version, "outside/vault", "not-a-date"),
    ).rejects.toThrow();
  });
  it("restores an emergency export as local content without reviving transport work", async () => {
    const db = await fixture(),
      row = await db.read();
    const restored = await restoreEmergencyExport(db, row.version, {
      protocolVersion: 2,
      files: {
        "raw/Inbox/recovered.md":
          "# 恢复\n\n![[raw/Inbox/recovered.assets/a.png]]",
      },
      attachments: {
        "raw/Inbox/recovered.assets/a.png": {
          encoding: "base64",
          data: "AA==",
        },
      },
    });
    expect(restored.files).toEqual({
      "raw/Inbox/recovered.md":
        "# 恢复\n\n![[raw/Inbox/recovered.assets/a.png]]",
    });
    expect(restored.attachments).toEqual({
      "raw/Inbox/recovered.assets/a.png": { encoding: "base64", data: "AA==" },
    });
    expect(restored.base).toBeNull();
    expect(restored.pending).toBeNull();
    expect(restored.pendingMove).toBeNull();
    expect(restored.conflict).toBeNull();
    expect((await db.recovery.toArray())[0].state.files[p]).toBe("base");
  });
  it("rejects invalid emergency exports before changing local data", async () => {
    const db = await fixture(),
      row = await db.read();
    await expect(
      restoreEmergencyExport(db, row.version, {
        protocolVersion: 2,
        files: { "raw/Inbox/bad.md": "bad" },
        attachments: {
          "raw/Inbox/bad.assets/not-supported.svg": {
            encoding: "base64",
            data: "",
          },
        },
      }),
    ).rejects.toThrow();
    expect(await db.read()).toEqual(row);
    expect(await db.recovery.count()).toBe(0);
  });
  it("only accepts the explicit versioned emergency export shape", () => {
    expect(
      readEmergencyExport({
        protocolVersion: 2,
        files: { [p]: "x" },
        attachments: {},
      }),
    ).toEqual({ protocolVersion: 2, files: { [p]: "x" }, attachments: {} });
    expect(() =>
      readEmergencyExport({ protocolVersion: 1, files: {}, attachments: {} }),
    ).toThrow();
    expect(() =>
      readEmergencyExport({
        protocolVersion: 2,
        files: {},
        attachments: {},
        base: {},
      }),
    ).toThrow();
  });
  it("retains outbound request and reuses its identity after a lost response", async () => {
    const db = await fixture();
    let firstBody = "";
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.body)
        return Response.json({ revision: "base", files: { [p]: "base" } });
      firstBody = String(init.body);
      throw new Error("response lost");
    });
    vi.stubGlobal("fetch", mock);
    await expect(synchronize(db)).rejects.toThrow("response lost");
    expect((await db.read()).pending?.requestId).toBe(
      JSON.parse(firstBody).requestId,
    );
    mock.mockImplementation(async (_url, init) => {
      expect(String(init?.body)).toBe(firstBody);
      return Response.json({
        revision: "committed",
        files: JSON.parse(firstBody).files,
      });
    });
    expect((await synchronize(db)).pending).toBeNull();
  });
  it("preserves edits made while a commit is in flight", async () => {
    const db = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) => {
        if (!init?.body)
          return Response.json({ revision: "base", files: { [p]: "base" } });
        const row = await db.read();
        await db.update(row.version, (r) => ({
          ...r,
          files: { [p]: "new in-flight edit" },
        }));
        return Response.json({
          revision: "committed",
          files: JSON.parse(String(init.body)).files,
        });
      }),
    );
    const after = await synchronize(db);
    expect(after.files[p]).toBe("new in-flight edit");
    expect(after.base?.files[p]).toBe("base");
  });
  it("preserves both conflict alternatives transactionally before choosing", async () => {
    const db = await fixture(),
      row = await db.read();
    await db.update(row.version, (r) => ({ ...r, files: { [p]: "local" } }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ revision: "remote", files: { [p]: "remote" } }),
      ),
    );
    const conflicted = await synchronize(db);
    expect(conflicted.conflict?.items).toHaveLength(1);
    const choice = conflictOptions(conflicted.conflict!.items[0])[0].key;
    const resolved = await resolveConflicts(db, conflicted, {
      [choice]: "remote",
    });
    expect(resolved.files[p]).toBe("remote");
    const backup = (await db.recovery.toArray())[0];
    expect(backup.state.files[p]).toBe("local");
    expect(backup.state.conflict?.items[0].remote).toBe("remote");
  });
  it("turns a server-side race into a non-destructive conflict", async () => {
    const db = await fixture(),
      row = await db.read();
    await db.update(row.version, (r) => ({ ...r, files: { [p]: "local" } }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) =>
        !init?.body
          ? Response.json({ revision: "base", files: { [p]: "base" } })
          : Response.json(
              { snapshot: { revision: "race", files: { [p]: "race" } } },
              { status: 409 },
            ),
      ),
    );
    const after = await synchronize(db);
    expect(after.pending).toBeNull();
    expect(after.files[p]).toBe("local");
    expect(after.conflict?.items[0].remote).toBe("race");
  });
  it("persists and resumes a move after an uncertain response", async () => {
    const db = await fixture();
    const initial = await db.read();
    await db.update(initial.version, (row) => ({
      ...row,
      recent: { "raw/Inbox/a": "2026-09-03T01:00:00.000Z" },
    }));
    let moveBody = "";
    let moved = false;
    const mock = vi.fn(async (url, init?: RequestInit): Promise<Response> => {
      if (url === "/api/move") {
        moveBody = String(init?.body);
        throw new Error("lost move response");
      }
      return Response.json({ revision: "base", files: { [p]: "base" } });
    });
    vi.stubGlobal("fetch", mock);
    await expect(moveDocument(db, p, "raw/Areas/a.md")).rejects.toThrow(
      "lost move",
    );
    expect((await db.read()).pendingMove?.requestId).toBe(
      JSON.parse(moveBody).requestId,
    );
    mock.mockImplementation(async (url, init) => {
      if (url === "/api/move") {
        expect(String(init?.body)).toBe(moveBody);
        moved = true;
      }
      return Response.json({
        revision: "moved",
        files: { "raw/Areas/a.md": "base" },
      });
    });
    const after = await synchronize(db);
    expect(moved).toBe(true);
    expect(after.pendingMove).toBeNull();
    expect(after.files[p]).toBeUndefined();
    expect(after.recent).toEqual({ "raw/Areas/a": "2026-09-03T01:00:00.000Z" });
  });
  async function conflicting() {
    const db = await fixture(),
      row = await db.read();
    await db.update(row.version, (r) => ({ ...r, files: { [p]: "local" } }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ revision: "remote", files: { [p]: "remote" } }),
      ),
    );
    const state = await synchronize(db);
    const key = conflictOptions(state.conflict!.items[0])[0].key;
    return { db, state, key };
  }
  it("persists fragment plans across reopening and resolves with the same keys", async () => {
    const { db, state, key } = await conflicting();
    db.close();
    await db.open();
    const reopened = await db.read();
    expect(reopened.conflict).toEqual(state.conflict);
    expect(
      (await resolveConflicts(db, reopened, { [key]: "local" })).files[p],
    ).toBe("local");
  });
  it("rejects stale-tab choices without creating a misleading recovery entry", async () => {
    const { db, state, key } = await conflicting();
    const newer = await db.update(state.version, (r) => ({
      ...r,
      files: { [p]: "newer draft" },
    }));
    await expect(
      resolveConflicts(db, state, { [key]: "remote" }),
    ).rejects.toThrow("标签页");
    expect(await db.read()).toEqual(newer);
    expect(await db.recovery.count()).toBe(0);
  });
  it("rolls back the backup too if saving the resolution fails", async () => {
    const { db, state, key } = await conflicting();
    const fail = () => {
      throw new Error("simulated storage write failure");
    };
    db.vault.hook("updating", fail);
    await expect(
      resolveConflicts(db, state, { [key]: "remote" }),
    ).rejects.toThrow("storage write failure");
    db.vault.hook("updating").unsubscribe(fail);
    expect(await db.read()).toEqual(state);
    expect(await db.recovery.count()).toBe(0);
  });
  it("backs up and upgrades legacy whole-file conflicts only once", async () => {
    const db = await fixture(),
      row = await db.read();
    const base = "top\n\ngap\n\nmiddle\n\ngap2\n\nbottom";
    const local = base
      .replace("top", "local top")
      .replace("middle", "local middle");
    const remote = base
      .replace("middle", "remote middle")
      .replace("bottom", "remote bottom");
    await db.vault.put({
      ...row,
      base: { revision: "base", files: { [p]: base } },
      files: { [p]: local },
      conflict: {
        remote: { revision: "remote", files: { [p]: remote } },
        merged: {},
        items: [{ path: p, base, local, remote }],
      },
    } as unknown as typeof row);
    const upgraded = await db.read();
    expect(upgraded.conflict?.formatVersion).toBe(2);
    expect(upgraded.conflict?.items[0].kind).toBe("text");
    expect(await db.recovery.count()).toBe(1);
    expect((await db.read()).version).toBe(upgraded.version);
    expect(await db.recovery.count()).toBe(1);
    const key = conflictOptions(upgraded.conflict!.items[0])[0].key;
    const resolved = await resolveConflicts(db, upgraded, { [key]: "remote" });
    expect(resolved.files[p]).toBe(
      local
        .replace("local middle", "remote middle")
        .replace("bottom", "remote bottom"),
    );
    expect((await db.recovery.toArray())[0].state.files[p]).toBe(local);
  });
  it("backs up and groups legacy graph conflicts before presenting choices", async () => {
    const db = await fixture(),
      row = await db.read();
    const opml = "raw/Inbox/g.opml",
      yaml = "raw/Inbox/g.relations.yaml";
    const xml = (body: string) =>
      serializeOpml({ title: "G", root: { ...topic("Root"), body } });
    const b = { [opml]: xml("base"), [yaml]: serializeRelations(opml, []) };
    const l = { ...b, [opml]: xml("local") },
      r = { ...b, [opml]: xml("remote") };
    await db.vault.put({
      ...row,
      files: l,
      base: { revision: "base", files: b },
      conflict: {
        remote: { revision: "remote", files: r },
        merged: { [yaml]: b[yaml] },
        items: [{ path: opml, base: b[opml], local: l[opml], remote: r[opml] }],
      },
    } as unknown as typeof row);
    const upgraded = await db.read();
    expect(upgraded.conflict?.items).toHaveLength(1);
    expect(upgraded.conflict?.items[0].kind).toBe("graph");
    expect(upgraded.conflict?.merged).toEqual({});
    expect(
      (await resolveConflicts(db, upgraded, { [opml]: "local" })).files,
    ).toEqual(l);
  });
  it("does not clear a conflict or write a recovery entry for an invalid choice result", async () => {
    const db = await fixture(),
      row = await db.read(),
      opml = "raw/Inbox/g.opml";
    const xml = (text: string) =>
      serializeOpml({ title: "G", root: topic(text) });
    const base = { [opml]: xml("base") },
      local = { [opml]: "<broken/>" },
      remote = { [opml]: xml("remote") };
    const plan = mergeFiles(base, local, remote);
    const state = await db.update(row.version, (r) => ({
      ...r,
      files: local,
      conflict: {
        formatVersion: 2,
        baseFiles: base,
        remote: { revision: "remote", files: remote },
        merged: plan.files,
        items: plan.conflicts,
      },
    }));
    await expect(
      resolveConflicts(db, state, { [opml]: "local" }),
    ).rejects.toThrow();
    expect(await db.read()).toEqual(state);
    expect(await db.recovery.count()).toBe(0);
    expect(
      (await resolveConflicts(db, state, { [opml]: "remote" })).files,
    ).toEqual(remote);
  });
  it("does not submit an auto-merged but invalid snapshot", async () => {
    const db = await fixture();
    const mock = vi.fn(async () =>
      Response.json({
        revision: "invalid",
        files: { [p]: "base", "raw/Inbox/g.relations.yaml": "invalid" },
      }),
    );
    vi.stubGlobal("fetch", mock);
    const before = await db.read();
    await expect(synchronize(db)).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(await db.read()).toEqual(before);
  });
  it("refuses unknown future conflict formats without changing the stored state", async () => {
    const { db, state } = await conflicting();
    const future = {
      ...state,
      conflict: { ...state.conflict, formatVersion: 99 },
    } as unknown as typeof state;
    await db.vault.put(future);
    await expect(db.read()).rejects.toThrow("未知冲突格式");
    expect(await db.vault.get("vault")).toEqual(future);
    expect(await db.recovery.count()).toBe(0);
  });
});
