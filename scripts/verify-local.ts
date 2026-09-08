import { spawnSync } from "node:child_process";

const commands = [
  ["typecheck", []],
  ["test", []],
  ["build", []],
  ["check:build", []],
] as const;

const command =
  process.platform === "win32"
    ? (script: string) => ({ file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `pnpm ${script}`] })
    : (script: string) => ({ file: "pnpm", args: [script] });
for (const [script, args] of commands) {
  console.log(`\n== pnpm ${script} ==`);
  const invocation = command(script);
  const result = spawnSync(invocation.file, [...invocation.args, ...args], {
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
console.log("\n本地验证全部通过；请另行运行 gitleaks 后再推送。\n");
