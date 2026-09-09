import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const appRoot = path.resolve(".");
const port = 48191;
const origin = `http://127.0.0.1:${port}`;
const password = "browser-memory-schedule-password";
const dataDir = await mkdtemp(path.join(appRoot, ".prototype-data", "browser-memory-schedule-"));
let server: ChildProcess | undefined;

function oneMinuteAgo() {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) return undefined;
  now.setMinutes(now.getMinutes() - 1);
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function localDate() {
  const now = new Date();
  const part = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${part(now.getMonth() + 1)}-${part(now.getDate())}`;
}

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
  throw new Error("隔离每日整理服务启动超时");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  if (!pid) throw new Error("隔离每日整理服务缺少进程标识");
  if (process.platform === "win32")
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], (error) => {
        if (error && server?.exitCode === null) reject(error);
        else resolve();
      });
    });
  else server.kill("SIGTERM");
}

const localTime = oneMinuteAgo();
if (!localTime) throw new Error("午夜边界不运行每日整理浏览器 smoke，请稍后重试");
const serverOptions = {
  cwd: appRoot,
  env: { ...process.env, ZFY_AUTH_PASSWORD: password, ZFY_DATA_DIR: dataDir, ZFY_PORT: String(port) },
  stdio: "ignore" as const,
};
function startServer() {
  server = spawn(process.execPath, ["--import", "tsx", "server/main.ts", "--production"], serverOptions);
}

try {
  // Let FileStore create its ownership marker before injecting a persisted
  // schedule state, exactly as a real server would have left it on disk.
  startServer();
  await waitForHealth();
  await stopServer();
  await mkdir(path.join(dataDir, "state"), { recursive: true });
  await writeFile(path.join(dataDir, "state", "memory-workflow.json"), JSON.stringify({
    version: 1,
    config: {
      enabled: true,
      localTime,
      capabilities: { summaries: true, inbox: false, dualView: false },
    },
    runs: [],
    confirmations: [],
    notifications: [],
  }));
  startServer();
  await waitForHealth();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByText("原文 / SOURCE").waitFor();
    await page.getByRole("button", { name: /管理员与每日整理/ }).click();
    await page.getByRole("heading", { name: "每日整理通知" }).waitFor();
    const notice = page.getByRole("button", { name: /已错过今日.*不会自动补跑/ });
    await notice.waitFor();
    await notice.click();
    await page.getByRole("heading", { name: "每日整理通知" }).waitFor({ state: "detached" });
    const state = await page.request.get(`${origin}/api/memory`);
    assert.equal(state.ok(), true, "登录后无法读取每日整理状态");
    const memory = await state.json();
    assert.equal(memory.lastMissedScheduledDate, localDate(), "未记录错过计划日期");
    console.log(`浏览器每日整理错过计划 smoke 通过：${origin}`);
  } finally {
    await browser.close();
  }
} finally {
  await stopServer();
}
