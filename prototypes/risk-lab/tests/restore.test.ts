import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  backupScopes,
  restorePrototype,
  type BackupTier,
} from "../server/restore";
import { FileStore } from "../server/store";

const p = "raw/Inbox/知识.md",
  q = "raw/Areas/知识.md";
async function fixture() {
  const base = path.resolve(".prototype-data/tests");
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "restore-"));
  const source = path.join(root, "source"),
    target = path.join(root, "restored");
  const store = new FileStore(source);
  await store.init(false);
  const before = await store.commit({
    requestId: "restore-seed",
    expectedRevision: (await store.snapshot()).revision,
    files: {
      [p]: "# 原始笔记\r\n保留格式😀",
      "derived/摘要.md": "既有摘要，不重新生成",
    },
  });
  return { root, source, target, store, before };
}
async function readAll(root: string) {
  const result: Record<string, string> = {};
  const walk = async (relative: string) => {
    for (const item of await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? relative + "/" + item.name : item.name;
      if (item.isDirectory()) await walk(name);
      else
        result[name] = (await fs.readFile(path.join(root, name))).toString(
          "base64",
        );
    }
  };
  await walk("");
  return result;
}
describe("isolated external backup restoration", () => {
  it.each<BackupTier>(["minimal", "standard", "full"])(
    "restores %s scope without changing its source or connecting a service",
    async (tier) => {
      const { source, target } = await fixture();
      for (const name of ["history", "trash", "config", "manager", "cache"]) {
        await fs.mkdir(path.join(source, name));
        await fs.writeFile(
          path.join(source, name, "sample.json"),
          '{"original":true}',
        );
      }
      const original = await readAll(source);
      const report = await restorePrototype(source, target, tier);
      expect(report.included).toEqual(backupScopes[tier]);
      expect(report.sync).toBe("disconnected");
      expect(report.ai).toBe("disabled");
      expect(await readAll(source)).toEqual(original);
      expect(await fs.readFile(path.join(target, p))).toEqual(
        await fs.readFile(path.join(source, p)),
      );
      const store = new FileStore(target);
      await store.init(false);
      const snapshot = await store.snapshot();
      expect(snapshot.files["derived/摘要.md"]).toBe(
        tier === "minimal" ? undefined : "既有摘要，不重新生成",
      );
      expect((await readAll(target))["history/sample.json"]).toBe(
        tier === "full" ? original["history/sample.json"] : undefined,
      );
      expect((await readAll(target))["state/ledger.json"]).toBe(
        tier === "full" ? original["state/ledger.json"] : undefined,
      );
      expect((await readAll(target))["cache/sample.json"]).toBeUndefined();
    },
  );
  it("opens a raw-only copy without the old marker, database, derived data or AI", async () => {
    const { root, source, target } = await fixture();
    const rawOnly = path.join(root, "raw-only");
    await fs.mkdir(rawOnly);
    await fs.cp(path.join(source, "raw"), path.join(rawOnly, "raw"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const report = await restorePrototype(rawOnly, target, "minimal");
    expect(report.included).toEqual(["raw"]);
    const store = new FileStore(target);
    await store.init(false);
    expect(Object.keys((await store.snapshot()).files)).toEqual([p]);
  });
  it.each(["prepared", "files", "ledger", "moves", "committed"] as const)(
    "recovers a full copied transaction at %s only in the destination",
    async (point) => {
      const { source, target, before } = await fixture();
      const failing = new FileStore(source, point);
      await failing.init(false);
      await expect(
        failing.move({
          requestId: "restore-move",
          expectedRevision: before.revision,
          from: p,
          to: q,
        }),
      ).rejects.toThrow("INJECTED_CRASH");
      const original = await readAll(source);
      const report = await restorePrototype(source, target, "full");
      expect(report.recoveredJournal).toBe(true);
      expect(await readAll(source)).toEqual(original);
      const restored = new FileStore(target);
      await restored.init(false);
      const snapshot = await restored.snapshot();
      if (point === "committed") {
        expect(snapshot.files[q]).toBe(before.files[p]);
        expect(snapshot.files[p]).toBeUndefined();
        expect(snapshot.moves).toHaveLength(1);
      } else expect(snapshot).toEqual(before);
      expect((await readAll(target))["state/journal.json"]).toBeUndefined();
    },
  );
  it("does not adopt even an empty pre-existing destination", async () => {
    const { source, target } = await fixture();
    await fs.mkdir(target);
    await expect(restorePrototype(source, target, "minimal")).rejects.toThrow(
      "新目录",
    );
    expect(await fs.readdir(target)).toEqual([]);
  });
  it("rejects overlapping or outside-sandbox targets without modifying them", async () => {
    const { source } = await fixture();
    await expect(
      restorePrototype(source, path.join(source, "nested"), "full"),
    ).rejects.toThrow("重叠");
    await expect(
      restorePrototype(source, path.resolve("outside-restore"), "full"),
    ).rejects.toThrow("仅接受");
    await expect(fs.lstat(path.join(source, "nested"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });
  it("leaves interrupted copies marked and refuses to initialize them", async () => {
    const { source, target } = await fixture();
    const original = await readAll(source);
    await expect(
      restorePrototype(source, target, "standard", { failAfterCopies: 1 }),
    ).rejects.toThrow("INJECTED_RESTORE_CRASH");
    expect(await readAll(source)).toEqual(original);
    expect(
      await fs.readFile(path.join(target, ".restore-incomplete"), "utf8"),
    ).toContain("standard");
    await expect(new FileStore(target).init()).rejects.toThrow("恢复尚未完成");
    await expect(restorePrototype(source, target, "standard")).rejects.toThrow(
      "新目录",
    );
  });
  it.each(["minimal", "standard"] as const)(
    "rejects %s when the source still has a pending transaction",
    async (tier) => {
      const { source, target, before } = await fixture();
      const failing = new FileStore(source, "files");
      await failing.init(false);
      await expect(
        failing.move({
          requestId: "unfinished",
          expectedRevision: before.revision,
          from: p,
          to: q,
        }),
      ).rejects.toThrow();
      await expect(restorePrototype(source, target, tier)).rejects.toThrow(
        "完整状态",
      );
      await expect(fs.lstat(target)).rejects.toHaveProperty("code", "ENOENT");
    },
  );
  it("rejects missing required scopes and unknown full-backup root items", async () => {
    const { source, target } = await fixture();
    await fs.rename(
      path.join(source, "derived"),
      path.join(source, "other-data"),
    );
    await expect(restorePrototype(source, target, "standard")).rejects.toThrow(
      "缺少",
    );
    await fs.mkdir(path.join(source, "derived"));
    await expect(restorePrototype(source, target, "full")).rejects.toThrow(
      "未知根目录",
    );
  });
  it("rejects linked source descendants and linked target ancestors", async () => {
    const { root, source, target } = await fixture();
    const linked = path.join(root, "linked");
    await fs.symlink(source, linked, "junction");
    await expect(
      restorePrototype(source, path.join(linked, "target"), "minimal"),
    ).rejects.toThrow("符号链接");
    await fs.symlink(
      path.join(source, "derived"),
      path.join(source, "raw/Inbox/linked"),
      "junction",
    );
    await expect(restorePrototype(source, target, "minimal")).rejects.toThrow(
      "链接",
    );
  });
  it("leaves invalid raw data marked instead of claiming a successful restore", async () => {
    const { source, target } = await fixture();
    await fs.writeFile(
      path.join(source, "raw/Inbox/broken.opml"),
      "<unknown/>",
    );
    await expect(restorePrototype(source, target, "minimal")).rejects.toThrow();
    await expect(new FileStore(target).init(false)).rejects.toThrow(
      "恢复尚未完成",
    );
  });
  it.each(["unknown-status", "bad-hash", "path-escape"])(
    "refuses a %s journal before any recovery write",
    async (defect) => {
      const { source, target, before } = await fixture();
      const failing = new FileStore(source, "files");
      await failing.init(false);
      await expect(
        failing.move({
          requestId: "bad-journal",
          expectedRevision: before.revision,
          from: p,
          to: q,
        }),
      ).rejects.toThrow();
      const file = path.join(source, "state/journal.json");
      const journal = JSON.parse(await fs.readFile(file, "utf8"));
      if (defect === "unknown-status") journal.status = "future-state";
      if (defect === "bad-hash") journal.before.revision = "invalid";
      if (defect === "path-escape")
        journal.before.files["../escape.md"] = "do not write";
      await fs.writeFile(file, JSON.stringify(journal));
      const original = await readAll(source);
      await expect(new FileStore(source).init(false)).rejects.toThrow();
      expect(await readAll(source)).toEqual(original);
      await expect(restorePrototype(source, target, "full")).rejects.toThrow();
      expect(await readAll(source)).toEqual(original);
      await expect(new FileStore(target).init(false)).rejects.toThrow(
        "恢复尚未完成",
      );
    },
  );
  it("reports absent optional full-backup folders without inventing their contents", async () => {
    const { source, target } = await fixture();
    const report = await restorePrototype(source, target, "full");
    expect(report.absent).toEqual(["history", "trash", "config", "manager"]);
    expect(report.warnings.join("\n")).toContain("无法判断源是否遗漏");
  });
  it("rejects orphan temporary files and unsupported binary originals", async () => {
    const { source, target } = await fixture();
    const temp = path.join(source, "raw/Inbox/unfinished.md.risk-tmp");
    await fs.writeFile(temp, "unfinished");
    await expect(restorePrototype(source, target, "minimal")).rejects.toThrow(
      "孤立临时",
    );
    // Preserve the sample rather than silently deleting unknown recovery data.
    await fs.rename(temp, path.join(source, "raw/Inbox/unfinished.md"));
    await fs.writeFile(
      path.join(source, "raw/Inbox/binary.png"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );
    await expect(restorePrototype(source, target, "minimal")).rejects.toThrow();
    await expect(new FileStore(target).init(false)).rejects.toThrow(
      "恢复尚未完成",
    );
  });
  it("rejects unknown marker versions and damaged ledgers", async () => {
    const { source, target } = await fixture();
    await fs.writeFile(path.join(source, ".risk-lab"), "risk-lab-v99");
    await expect(restorePrototype(source, target, "full")).rejects.toThrow(
      "未知原型",
    );
    await fs.writeFile(path.join(source, ".risk-lab"), "risk-lab-v1");
    await fs.writeFile(
      path.join(source, "state/ledger.json"),
      '{"invalid":{"future":true}}',
    );
    await expect(restorePrototype(source, target, "full")).rejects.toThrow();
    await expect(new FileStore(target).init(false)).rejects.toThrow(
      "恢复尚未完成",
    );
  });
});
