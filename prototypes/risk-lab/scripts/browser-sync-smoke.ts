import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const appRoot = path.resolve(".");
const port = 48176;
const origin = `http://127.0.0.1:${port}`;
const password = "browser-sync-smoke-password";
const title = "跨浏览器同步验证";
const dataDir = await mkdtemp(path.join(appRoot, ".prototype-data", "browser-sync-"));
let server: ChildProcess | undefined;

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      // The isolated server has not bound the loopback port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("隔离同步服务启动超时");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  if (!pid) throw new Error("隔离同步服务缺少进程标识");
  if (process.platform === "win32")
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], (error) => {
        if (error && server?.exitCode === null) reject(error);
        else resolve();
      });
    });
  else server.kill("SIGTERM");
}

async function login(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByText("原文 / SOURCE").waitFor();
  return page;
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
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const first = await browser.newContext();
    const firstPage = await login(first);
    await firstPage.getByRole("button", { name: "＋ 笔记" }).click();
    const firstTitle = firstPage.getByLabel("文档标题");
    await firstTitle.fill(title);
    await firstPage.getByRole("button", { name: "同步并检查外部变更" }).click();
    await firstPage.getByText("已同步本地测试服务").waitFor();

    const second = await browser.newContext();
    const secondPage = await login(second);
    const remoteNote = secondPage.getByRole("button", { name: new RegExp(title) });
    await remoteNote.waitFor();
    await remoteNote.click();
    assert.equal(
      await secondPage.getByLabel("文档标题").inputValue(),
      title,
      "第二个独立浏览器没有从服务器读取刚同步的笔记",
    );
    await first.close();
    await second.close();
    console.log(`浏览器跨客户端同步 smoke 通过：${origin}`);
  } finally {
    await browser.close();
  }
} finally {
  await stopServer();
}
