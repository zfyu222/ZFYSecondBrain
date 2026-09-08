import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";

const scripts = [
  "browser:smoke",
  "browser:auth-smoke",
  "browser:offline-smoke",
  "browser:sync-smoke",
  "browser:conflict-smoke",
  "browser:move-smoke",
  "browser:media-smoke",
  "browser:dual-view-smoke",
  "browser:tab-smoke",
];
const origin = "http://127.0.0.1:4173";
const invocation = (script: string) =>
  process.platform === "win32"
    ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `pnpm ${script}`] }
    : { file: "pnpm", args: [script] };

async function healthy() {
  try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; }
}
async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("本地浏览器验证服务启动超时");
}
async function stop(processHandle: ChildProcess) {
  if (processHandle.exitCode !== null || !processHandle.pid) return;
  if (process.platform === "win32")
    await new Promise<void>((resolve, reject) =>
      execFile("taskkill.exe", ["/PID", String(processHandle.pid), "/T", "/F"], (error) =>
        error && processHandle.exitCode === null ? reject(error) : resolve(),
      ),
    );
  else processHandle.kill("SIGTERM");
}

async function main() {
  let ownedServer: ChildProcess | undefined;
  try {
    if (!(await healthy())) {
      const serverCommand = invocation("dev:prototype");
      ownedServer = spawn(serverCommand.file, serverCommand.args, { stdio: "ignore", shell: false });
      await waitForHealth();
    }
    for (const script of scripts) {
      console.log(`\n== pnpm ${script} ==`);
      const command = invocation(script);
      const result = spawnSync(command.file, command.args, { stdio: "inherit", shell: false });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`浏览器验证失败：${script}（退出码 ${result.status ?? 1}）`);
    }
  } finally {
    if (ownedServer) await stop(ownedServer);
  }
  console.log("\n本地浏览器验证全部通过。\n");
}

void main();
