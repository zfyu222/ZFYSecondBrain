import { spawnSync } from "node:child_process";

const commands = [
  ["typecheck", []],
  ["test", []],
  ["build", []],
  ["check:build", []],
] as const;

const pnpm = "pnpm";
for (const [script, args] of commands) {
  console.log(`\n== pnpm ${script} ==`);
  const result = spawnSync(pnpm, [script, ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
console.log("\n本地验证全部通过；请另行运行 gitleaks 后再推送。\n");
