import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const appRoot = path.resolve(".");
const port = 48179;
const origin = `http://127.0.0.1:${port}`;
const password = "browser-media-smoke-password";
const dataDir = await mkdtemp(path.join(appRoot, ".prototype-data", "browser-media-"));
let server: ChildProcess | undefined;
const execFileAsync = promisify(execFile);

function emptyWav() {
  const bytes = Buffer.alloc(44);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(0, 40);
  return bytes;
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      // The isolated service has not bound the loopback port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("隔离媒体服务启动超时");
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  if (!pid) throw new Error("隔离媒体服务缺少进程标识");
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
    env: { ...process.env, ZFY_AUTH_PASSWORD: password, ZFY_DATA_DIR: dataDir, ZFY_PORT: String(port) },
    stdio: "ignore",
  });
  await waitForHealth();
  const videoPath = path.join(dataDir, "sample.mp4");
  await execFileAsync("ffmpeg", [
    "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", videoPath,
  ]);
  const videoBytes = await readFile(videoPath);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12_000);
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByText("原文 / SOURCE").waitFor();
    await page.getByRole("button", { name: "＋ 笔记" }).click();
    await page.getByLabel("文档标题").fill("媒体预览验证");
    const picker = page.getByLabel("添加本机附件");
    const files = [
      { name: "pixel.gif", mimeType: "image/gif", buffer: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64") },
      { name: "silence.wav", mimeType: "audio/wav", buffer: emptyWav() },
      { name: "sample.mp4", mimeType: "video/mp4", buffer: videoBytes },
      { name: "sample.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") },
    ];
    for (const file of files) {
      await picker.setInputFiles(file);
      await page.getByText("附件和引用已保存本机 · 待同步").waitFor();
    }
    await page.locator(".attachment-media").first().waitFor();
    await page.locator(".attachment-media img").waitFor();
    await page.locator(".attachment-media audio").waitFor();
    await page.locator(".attachment-media video").waitFor();
    await page.locator(".attachment-media iframe").waitFor();
    assert.equal(await page.locator(".attachment-media img").count(), 1, "图片预览未出现");
    assert.equal(await page.locator(".attachment-media audio").count(), 1, "音频控件未出现");
    assert.equal(await page.locator(".attachment-media video").count(), 1, "视频控件未出现");
    assert.equal(await page.locator(".attachment-media iframe").count(), 1, "PDF 查看器未出现");
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${origin}/`, { waitUntil: "networkidle" });
    if (await mobile.locator('input[type="password"]').count()) {
      await mobile.locator('input[type="password"]').fill(password);
      await mobile.getByRole("button", { name: "登录" }).click();
    }
    await mobile.getByText("原文 / SOURCE").waitFor();
    assert.equal(
      await mobile.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
      "媒体预览在 390px 窄屏产生横向溢出",
    );
    await mobile.close();
    console.log(`浏览器媒体预览 smoke 通过：${origin}`);
  } finally {
    await browser.close();
  }
} finally {
  await stopServer();
}
