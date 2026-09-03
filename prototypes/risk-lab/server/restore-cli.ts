import { backupScopes, restorePrototype, type BackupTier } from "./restore";

const [tier, source, target, ...extra] = process.argv.slice(2);
if (tier === "--list" && !source) {
  console.log(
    JSON.stringify(
      {
        scopes: backupScopes,
        excluded: ["cache"],
        note: "由外部备份软件复制；暂停写入或使用一致性快照；未同步的浏览器草稿不在这些目录中。",
      },
      null,
      2,
    ),
  );
} else if (
  !tier ||
  !Object.hasOwn(backupScopes, tier) ||
  !source ||
  !target ||
  extra.length
) {
  console.error(
    "用法：tsx server/restore-cli.ts --list | <minimal|standard|full> <源目录> <新的目标目录>\n仅处理本原型 .prototype-data 内的测试数据；没有备份创建功能。",
  );
  process.exitCode = 1;
} else {
  try {
    console.log(
      JSON.stringify(
        await restorePrototype(source, target, tier as BackupTier),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      "恢复未完成，源未修改；若已创建目标，请保留现场，不要作为知识库使用。\n" +
        String(error),
    );
    process.exitCode = 1;
  }
}
