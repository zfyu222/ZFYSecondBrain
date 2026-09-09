import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const appRoot = path.resolve(".");
const port = 48175;
const origin = `http://127.0.0.1:${port}`;
const password = "browser-auth-smoke-password";
const dataDir = await mkdtemp(path.join(appRoot, ".prototype-data", "browser-auth-"));
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
  throw new Error("隔离认证服务启动超时");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  if (!pid) throw new Error("隔离认证服务缺少进程标识");
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
    page.setDefaultTimeout(8_000);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "第二大脑" }).waitFor();
    await page.locator('input[type="password"]').fill("wrong-password");
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByText("账号或密码错误").waitFor();
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByText("原文 / SOURCE").waitFor();
    const protectedSnapshot = await page.request.get(`${origin}/api/snapshot`);
    assert.equal(protectedSnapshot.ok(), true, "登录后 Cookie 未保护快照请求");
    await page.locator('.cm-content[contenteditable="true"]').first().fill(
      "# 退出保护验证\n\n本机草稿尚未同步。\n",
    );
    await page.getByText("已保存本机 · 待同步").waitFor();
    const undo = page.getByRole("button", { name: "撤销", exact: true });
    assert.equal(await undo.isEnabled(), true, "Markdown 修改后撤销按钮没有启用");
    await undo.click();
    await page.waitForFunction(
      () => !document.querySelector(".cm-content")?.textContent?.includes("本机草稿尚未同步"),
    );
    await page.locator('.cm-content[contenteditable="true"]').first().fill(
      "# 退出保护验证\n\n本机草稿尚未同步。\n",
    );
    await page.getByText("已保存本机 · 待同步").waitFor();
    const unloadGuard = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(unloadGuard, true, "未同步草稿没有阻止 beforeunload");
    let warned = false;
    page.once("dialog", async (dialog) => {
      warned = dialog.message().includes("尚未同步");
      await dialog.accept();
    });
    await page.getByRole("button", { name: "退出登录" }).click();
    await page.getByRole("heading", { name: "第二大脑" }).waitFor();
    assert.equal(warned, true, "未同步草稿退出时没有出现保护提示");
    console.log(`浏览器认证 smoke 通过：${origin}`);
  } finally {
    await browser.close();
  }
} finally {
  await stopServer();
}
