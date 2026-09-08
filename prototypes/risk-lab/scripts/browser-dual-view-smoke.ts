import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const appRoot = path.resolve(".");
const port = 48180;
const origin = `http://127.0.0.1:${port}`;
const password = "browser-dual-view-smoke-password";
const dataDir = await mkdtemp(path.join(appRoot, ".prototype-data", "browser-dual-view-"));
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
  throw new Error("隔离双视图服务启动超时");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  if (!pid) throw new Error("隔离双视图服务缺少进程标识");
  if (process.platform === "win32")
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], (error) => {
        if (error && server?.exitCode === null) reject(error);
        else resolve();
      });
    });
  else server.kill("SIGTERM");
}

async function replaceMarkdown(page: import("@playwright/test").Page, value: string) {
  const editor = page.getByLabel("Markdown 编辑器").locator(".cm-content");
  await editor.click();
  await editor.press("Control+A");
  await page.keyboard.insertText(value);
}

try {
  server = spawn(process.execPath, ["--import", "tsx", "server/main.ts", "--production"], {
    cwd: appRoot,
    env: { ...process.env, ZFY_AUTH_PASSWORD: password, ZFY_DATA_DIR: dataDir, ZFY_PORT: String(port) },
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
    await replaceMarkdown(page, "# Root\n\n初始正文\n");
    await page.getByText("已保存本机 · 待同步").waitFor();
    await page.getByRole("button", { name: "为本文启用导图" }).click();
    await page.getByRole("button", { name: "思维导图", exact: true }).click();
    await page.getByLabel("节点正文").fill("导图独立备注");
    await page.getByText("已保存本机 · 待同步").waitFor();
    await page.getByRole("button", { name: "Markdown", exact: true }).click();
    await replaceMarkdown(page, "# Root\n\n初始正文\n\n## 增量节点\n\n增量内容\n");
    await page.getByRole("button", { name: "按 Markdown 增量同步" }).click();
    await page.waitForTimeout(500);
    const pageText = await page.locator("body").innerText();
    assert.equal(
      pageText.includes("双视图已记录为一致（可增量同步）"),
      true,
      `增量同步未完成：${pageText}`,
    );
    await page.getByText(/双视图增量同步完成（.*）· 另一侧独立修改已保留/).waitFor();
    await page.getByRole("button", { name: "思维导图", exact: true }).click();
    assert.equal(
      await page.getByLabel("节点正文").inputValue(),
      "导图独立备注",
      "增量同步覆盖了导图侧独立正文",
    );
    assert.equal(
      (await page.locator(".react-flow__node").allTextContents()).some((text) => text.includes("增量节点")),
      true,
      "增量同步没有将 Markdown 新节点写入导图",
    );
    console.log(`浏览器双视图增量同步 smoke 通过：${origin}`);
  } finally {
    await browser.close();
  }
} finally {
  await stopServer();
}
