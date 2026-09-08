import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, type BrowserContext } from "@playwright/test";

const appRoot = path.resolve(".");
const port = 48177;
const origin = `http://127.0.0.1:${port}`;
const password = "browser-tab-smoke-password";
const marker = "标签页广播已同步";
const dataDir = await mkdtemp(path.join(appRoot, ".prototype-data", "browser-tab-"));
let server: ChildProcess | undefined;

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("隔离标签页服务启动超时");
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  if (!pid) throw new Error("隔离标签页服务缺少进程标识");
  if (process.platform === "win32")
    await new Promise<void>((resolve, reject) => execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], (error) => error && server?.exitCode === null ? reject(error) : resolve()));
  else server.kill("SIGTERM");
}
async function openApp(context: BrowserContext) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await Promise.race([page.locator('input[type="password"]').waitFor(), page.getByText("原文 / SOURCE").waitFor()]);
  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "登录" }).click();
  }
  await page.getByText("原文 / SOURCE").waitFor();
  await expect(page.locator("fieldset.editing-area")).toBeEnabled();
  await expect(page.locator('.cm-content[contenteditable="true"]').first()).toBeVisible();
  return page;
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
    const context = await browser.newContext();
    const first = await openApp(context);
    const second = await openApp(context);
    const firstEditor = first.locator('.cm-content[contenteditable="true"]').first();
    await firstEditor.click();
    await firstEditor.press("Control+A");
    await first.keyboard.insertText(`# ${marker}\n\n标签页之间的本地版本广播。\n`);
    await expect(firstEditor).toContainText(marker);
    // The editor update is synchronous, but the IndexedDB commit and
    // BroadcastChannel notification are intentionally debounced. Give that
    // local transaction a turn before asserting the sibling tab's reload.
    await first.waitForTimeout(750);
    const secondEditor = second.locator('.cm-content[contenteditable="true"]').first();
    await expect(secondEditor).toContainText(marker, { timeout: 12_000 });
    assert.ok((await secondEditor.innerText()).includes(marker));
    await context.close();
    console.log(`浏览器同标签页联动 smoke 通过：${origin}`);
  } finally { await browser.close(); }
} finally { await stopServer(); }
