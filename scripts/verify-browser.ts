import { spawnSync } from "node:child_process";

const scripts = ["browser:smoke", "browser:dual-view-smoke", "browser:tab-smoke"];
const invocation = (script: string) =>
  process.platform === "win32"
    ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `pnpm ${script}`] }
    : { file: "pnpm", args: [script] };

for (const script of scripts) {
  console.log(`\n== pnpm ${script} ==`);
  const command = invocation(script);
  const result = spawnSync(command.file, command.args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("\n本地浏览器验证全部通过。\n");
