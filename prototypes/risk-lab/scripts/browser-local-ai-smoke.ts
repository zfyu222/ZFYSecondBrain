import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const appRoot = path.resolve(".");
const port = 48191;
const origin = `http://127.0.0.1:${port}`;
const password = "browser-local-ai-smoke-password";
const dataDir = await mkdtemp(path.join(appRoot, ".prototype-data", "browser-local-ai-"));
let server: ChildProcess | undefined;

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      // The isolated process has not bound the loopback port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("隔离本地 AI 服务启动超时");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  if (!pid) throw new Error("隔离本地 AI 服务缺少进程标识");
  if (process.platform === "win32")
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], (error) => {
        if (error && server?.exitCode === null) reject(error);
        else resolve();
      });
    });
  else server.kill("SIGTERM");
}

try {
  server = spawn(process.execPath, ["--import", "tsx", "server/main.ts", "--production"], {
    cwd: appRoot,
    env: {
      ...process.env,
      ZFY_AUTH_PASSWORD: password,
      ZFY_DATA_DIR: dataDir,
      ZFY_PORT: String(port),
    },
    stdio: "ignore",
  });
  await waitForHealth();
  const health = await (await fetch(`${origin}/api/health`)).json() as { aiConfigured?: unknown };
  if (health.aiConfigured !== true)
    throw new Error("本地 .env 未配置 DEEPSEEK_API_KEY，跳过真实模型验收");

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByRole("button", { name: /管理员与每日整理/ }).click();
    await page.getByLabel("询问知识管理员").fill("第二大脑");
    await page.getByRole("button", { name: "获取带引用的回答" }).click();
    const answer = page.locator("article.manager-answer");
    await answer.waitFor();
    assert.ok(await answer.locator("code").count(), "真实模型回答缺少经本机验证的原文引用");
    console.log(`本地真实 AI smoke 通过：${origin}`);
  } finally {
    await browser.close();
  }
} finally {
  await stopServer();
}
