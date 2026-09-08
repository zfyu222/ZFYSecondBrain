import { spawnSync } from "node:child_process";

const scripts = ["verify:local", "verify:browser"];
const invocation = (script: string) =>
  process.platform === "win32"
    ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `pnpm ${script}`] }
    : { file: "pnpm", args: [script] };

for (const script of scripts) {
  console.log(`\n== pnpm ${script} ==`);
  const command = invocation(script);
  const result = spawnSync(command.file, command.args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`发布门禁失败：${script}`);
}
console.log("\n首版发布前本地门禁全部通过。\n");
