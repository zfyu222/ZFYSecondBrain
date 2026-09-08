import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const appRoot = path.resolve(".");
const port = 48177;
const origin = `http://127.0.0.1:${port}`;
const password = "browser-conflict-smoke-password";
const originalTitle = "冲突验证原文";
const localTitle = "冲突验证本机修改";
const remoteTitle = "冲突验证服务端修改";
const dataDir = await mkdtemp(path.join(appRoot, ".prototype-data", "browser-conflict-"));
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
  throw new Error("隔离冲突服务启动超时");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  if (!pid) throw new Error("隔离冲突服务缺少进程标识");
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
    const local = await browser.newContext();
    const localPage = await login(local);
    await localPage.getByRole("button", { name: "＋ 笔记" }).click();
    await localPage.getByLabel("文档标题").fill(originalTitle);
    await localPage.getByRole("button", { name: "同步并检查外部变更" }).click();
    await localPage.getByText("已同步本地测试服务").waitFor();

    const remote = await browser.newContext();
    const remotePage = await login(remote);
    const note = remotePage.getByRole("button", { name: new RegExp(originalTitle) });
    await note.waitFor();
    await note.click();

    await localPage.getByLabel("模拟断网").check();
    await localPage.getByLabel("文档标题").fill(localTitle);
    await remotePage.getByLabel("文档标题").fill(remoteTitle);
    await remotePage.getByRole("button", { name: "同步并检查外部变更" }).click();
    await remotePage.getByText("已同步本地测试服务").waitFor();

    await localPage.getByLabel("模拟断网").uncheck();
    await localPage.getByRole("button", { name: "同步并检查外部变更" }).click();
    await localPage.getByRole("heading", { name: "保留哪一版？" }).waitFor();
    const saveChoice = localPage.getByRole("button", { name: "保存选择" });
    assert.equal(await saveChoice.isVisible(), true, "冲突界面没有提供显式保存选择入口");
    await local.close();
    await remote.close();
    console.log(`浏览器跨客户端冲突 smoke 通过：${origin}`);
  } finally {
    await browser.close();
  }
} finally {
  await stopServer();
}
