import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const appRoot = path.resolve(".");
const port = 48178;
const origin = `http://127.0.0.1:${port}`;
const password = "browser-move-smoke-password";
const title = "附件移动验证";
const destination = "raw/Areas/附件移动验证.md";
const dataDir = await mkdtemp(path.join(appRoot, ".prototype-data", "browser-move-"));
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
  throw new Error("隔离移动服务启动超时");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  if (!pid) throw new Error("隔离移动服务缺少进程标识");
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
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12_000);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByText("原文 / SOURCE").waitFor();
    await page.getByRole("button", { name: "＋ 笔记" }).click();
    await page.getByLabel("文档标题").fill(title);
    await page.getByLabel("添加本机附件").setInputFiles({
      name: "move.gif",
      mimeType: "image/gif",
      buffer: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
    });
    await page.getByText("附件和引用已保存本机 · 待同步").waitFor();
    await page.getByRole("button", { name: "为本文启用导图" }).click();
    await page.getByRole("button", { name: "记录当前双视图基线" }).waitFor();
    await page.getByRole("button", { name: "记录当前双视图基线" }).click();
    await page.getByRole("button", { name: "同步并检查外部变更" }).click();
    await page.getByText("已同步本地测试服务").waitFor();
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await page.getByText("验证工具与原始文件", { exact: true }).click();
    await page.getByLabel("移动目标路径").fill(destination);
    await page.getByRole("button", { name: "移动当前笔记" }).click();
    await page.getByText("已移动并更新受支持的 Markdown 引用").waitFor();
    await page.getByRole("button", { name: "同步并检查外部变更" }).click();
    await page.getByText("已同步本地测试服务").waitFor();
    await access(path.join(dataDir, ...destination.split("/")));
    await access(path.join(dataDir, "raw", "Areas", "附件移动验证.assets", "move.gif"));
    assert.equal(await page.getByLabel("移动目标路径").inputValue(), destination);
    console.log(`浏览器附件与双视图移动 smoke 通过：${origin}`);
  } finally {
    await browser.close();
  }
} finally {
  await stopServer();
}
