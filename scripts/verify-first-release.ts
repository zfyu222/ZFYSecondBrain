import { spawnSync } from "node:child_process";

const remoteOrigin = process.env.ZFY_REMOTE_ORIGIN;
const remotePassword = process.env.ZFY_REMOTE_PASSWORD;
const remoteRequested = Boolean(remoteOrigin || remotePassword);
if (remoteRequested && (!remoteOrigin || !remotePassword))
  throw new Error("远程首版验收需要同时设置 ZFY_REMOTE_ORIGIN 和 ZFY_REMOTE_PASSWORD");

const scripts = ["verify:release"];
if (remoteOrigin && remotePassword) {
  scripts.push("browser:remote-smoke");
  if (process.env.ZFY_REMOTE_INCLUDE_AI === "1") scripts.push("browser:remote-ai-smoke");
}

const invocation = (script: string) =>
  process.platform === "win32"
    ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `pnpm ${script}`] }
    : { file: "pnpm", args: [script] };

for (const script of scripts) {
  console.log(`\n== pnpm ${script} ==`);
  const command = invocation(script);
  const result = spawnSync(command.file, command.args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`首版验收失败：${script}`);
}

console.log(
  remoteOrigin
    ? "\n首版本地与远程验收全部通过。\n"
    : "\n首版本地验收全部通过；设置远程变量后可继续执行远程验收。\n",
);
