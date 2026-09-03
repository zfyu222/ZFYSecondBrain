import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { FileStore } from "./store";
import { ledgerSchema } from "./journal";
import { validateContent } from "../src/core/contracts";
import { noLinkedAncestors } from "./safe-path";

export const backupScopes = {
  minimal: ["raw"],
  standard: ["raw", "derived"],
  full: ["raw", "derived", "history", "trash", "config", "state", "manager"],
} as const;
export type BackupTier = keyof typeof backupScopes;
const sandbox = fileURLToPath(new URL("../.prototype-data", import.meta.url));
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
async function stat(file: string) {
  return fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

type Entry = { relative: string; digest: string | null; size: number };
async function inventory(root: string, names: readonly string[]) {
  const entries: Entry[] = [];
  let bytes = 0;
  const walk = async (relative: string, depth: number) => {
    if (depth > 64 || entries.length >= 1000)
      throw new Error("超过原型恢复目录/文件数量限制");
    const absolute = path.join(root, relative);
    const info = await fs.lstat(absolute);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error("恢复不接受链接或特殊文件");
    if (info.isDirectory()) {
      entries.push({ relative, digest: null, size: 0 });
      const children = (await fs.readdir(absolute)).sort();
      const folded = new Set<string>();
      for (const child of children) {
        if (
          /[\\\x00-\x1f<>:"|?*]/.test(child) ||
          /[. ]$/.test(child) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(child)
        )
          throw new Error("不兼容 Windows 的恢复路径");
        const key = child.normalize("NFC").toLowerCase();
        if (folded.has(key)) throw new Error("恢复目录存在大小写/Unicode 重名");
        folded.add(key);
        await walk(`${relative}/${child}`, depth + 1);
      }
    } else {
      bytes += info.size;
      if (bytes > 50_000_000) throw new Error("超过原型恢复 50 MB 限制");
      const content = await fs.readFile(absolute);
      entries.push({ relative, digest: hash(content), size: content.length });
    }
  };
  for (const name of names)
    if (await stat(path.join(root, name))) await walk(name, 0);
  return entries;
}

/** Isolated risk experiment, not a backup creator or a production import API. */
export async function restorePrototype(
  sourceInput: string,
  targetInput: string,
  tier: BackupTier,
  options: { failAfterCopies?: number } = {},
) {
  if (!Object.hasOwn(backupScopes, tier)) throw new Error("未知备份档位");
  const source = path.resolve(sourceInput),
    target = path.resolve(targetInput);
  if (!within(sandbox, source) || !within(sandbox, target))
    throw new Error("恢复实验仅接受原型 .prototype-data 内的独立目录");
  if (source === target || within(source, target) || within(target, source))
    throw new Error("备份源与恢复目标不能重叠");
  await noLinkedAncestors(source);
  await noLinkedAncestors(target);
  if (!(await stat(source))?.isDirectory()) throw new Error("备份源目录不存在");
  if (await stat(target)) throw new Error("恢复目标必须是尚不存在的新目录");
  if (await stat(path.join(source, ".restore-incomplete")))
    throw new Error("不能恢复尚未完成的副本");
  const marker = path.join(source, ".risk-lab");
  if (await stat(marker)) {
    if (
      (await fs.lstat(marker)).isSymbolicLink() ||
      !["risk-lab-v1", "risk-lab-v2"].includes(
        await fs.readFile(marker, "utf8"),
      )
    )
      throw new Error("未知原型备份版本");
  }
  for (const name of tier === "minimal" ? ["raw"] : ["raw", "derived"]) {
    const info = await stat(path.join(source, name));
    if (!info?.isDirectory() || info.isSymbolicLink())
      throw new Error("备份缺少所选档位目录：" + name);
  }
  const stateInfo = await stat(path.join(source, "state"));
  if (stateInfo?.isSymbolicLink()) throw new Error("恢复不接受链接状态目录");
  if (tier !== "full" && (await stat(path.join(source, "state/journal.json"))))
    throw new Error(
      "源存在未完成事务，需要完整状态恢复；不能只复制 raw/derived",
    );
  const sourceNames = (await fs.readdir(source)).sort();
  const known = new Set<string>([
    ...backupScopes.full,
    "cache",
    ".risk-lab",
    ".restore-report.json",
  ]);
  if (tier === "full" && sourceNames.some((name) => !known.has(name)))
    throw new Error("完整备份存在未知根目录项，停止以免遗漏数据");
  const entries = await inventory(source, backupScopes[tier]);
  if (
    entries.some((entry) => entry.relative.endsWith(".risk-tmp")) &&
    !entries.some((entry) => entry.relative === "state/journal.json")
  )
    throw new Error("存在孤立临时文件，无法确定备份一致性");
  const included = backupScopes[tier].filter((name) =>
    entries.some((entry) => entry.relative === name),
  );
  const includedSet = new Set<string>(included);
  const excluded = sourceNames.filter((name) => !includedSet.has(name));
  // Exclusive creation: no existing library is ever adopted or overwritten.
  await fs.mkdir(target);
  const incomplete = path.join(target, ".restore-incomplete");
  await fs.writeFile(incomplete, JSON.stringify({ version: 1, tier, source }), {
    flag: "wx",
  });
  let copied = 0;
  for (const entry of entries) {
    const dest = path.join(target, entry.relative);
    if (entry.digest === null) await fs.mkdir(dest);
    else {
      await fs.copyFile(
        path.join(source, entry.relative),
        dest,
        constants.COPYFILE_EXCL,
      );
      if (hash(await fs.readFile(dest)) !== entry.digest)
        throw new Error("备份源在恢复期间变化：" + entry.relative);
      if (++copied === options.failAfterCopies)
        throw new Error("INJECTED_RESTORE_CRASH");
    }
  }
  if (
    JSON.stringify(await inventory(source, backupScopes[tier])) !==
    JSON.stringify(entries)
  )
    throw new Error("备份源在恢复期间变化，保留未完成副本");
  for (const name of ["raw", "derived", "state"])
    await fs.mkdir(path.join(target, name), { recursive: true });
  const ledgerPath = path.join(target, "state/ledger.json");
  if (await stat(ledgerPath))
    ledgerSchema.parse(JSON.parse(await fs.readFile(ledgerPath, "utf8")));
  const recoveredJournal = !!(await stat(
    path.join(target, "state/journal.json"),
  ));
  const restored = new FileStore(target);
  const snapshot = await restored.snapshot(); // Recover only the new copy, never the source.
  validateContent(snapshot.files, snapshot.attachments);
  if (
    (await inventory(target, ["raw", "derived"])).some((entry) =>
      entry.relative.endsWith(".risk-tmp"),
    )
  )
    throw new Error("恢复后仍有未确认的临时文件，保留现场");
  const report = {
    version: 1,
    tier,
    source,
    target,
    included,
    excluded,
    absent: backupScopes[tier].filter((name) => !includedSet.has(name)),
    copiedFiles: entries.filter((entry) => entry.digest !== null).length,
    recoveredJournal,
    revision: snapshot.revision,
    sync: "disconnected",
    ai: "disabled",
    warnings: [
      "仅验证当前 UTF-8 原文和受限 .assets 二进制副本；不证明媒体解码、历史或配置语义兼容。",
      "没有外部文件清单，无法判断源是否遗漏文件；备份前必须暂停写入或使用一致性快照。",
      "未复制的数据不能精确重建；恢复副本没有接入原服务，重新配对流程尚未实现。",
    ],
  };
  await fs.writeFile(
    path.join(target, ".restore-report.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  await fs.writeFile(
    path.join(target, ".risk-lab"),
    snapshot.attachments ||
      ((await stat(marker)) &&
        (await fs.readFile(marker, "utf8")) === "risk-lab-v2")
      ? "risk-lab-v2"
      : "risk-lab-v1",
    {
      flag: "wx",
    },
  );
  await fs.unlink(incomplete);
  return report;
}
