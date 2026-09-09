import { chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";

const origin = process.env.ZFY_REMOTE_ORIGIN;
const password = process.env.ZFY_REMOTE_PASSWORD;
if (!origin || !password)
  throw new Error("请设置 ZFY_REMOTE_ORIGIN 和 ZFY_REMOTE_PASSWORD 后再运行远程 smoke");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const temporaryTitle = `远程同步验收-${randomUUID()}`;
const temporaryPath = `raw/Inbox/${temporaryTitle}.md`;
const temporaryAssetPrefix = `raw/Inbox/${temporaryTitle}.assets/`;
let cleanupPage: Awaited<ReturnType<typeof browser.newPage>> | undefined;

async function removeTemporaryNote() {
  if (!cleanupPage) return;
  const snapshotResponse = await cleanupPage.request.get(`${origin!.replace(/\/$/, "")}/api/snapshot`, {
    headers: { "X-Vault-Protocol": "2" },
  });
  if (!snapshotResponse.ok()) throw new Error("无法读取远程临时验收笔记以清理");
  const snapshot = await snapshotResponse.json() as {
    revision: string;
    files: Record<string, string>;
    attachments?: Record<string, unknown>;
  };
  if (!(temporaryPath in snapshot.files) && !Object.keys(snapshot.attachments ?? {}).some((path) => path.startsWith(temporaryAssetPrefix))) return;
  const { [temporaryPath]: _removed, ...files } = snapshot.files;
  const attachments = Object.fromEntries(
    Object.entries(snapshot.attachments ?? {}).filter(([path]) => !path.startsWith(temporaryAssetPrefix)),
  );
  const response = await cleanupPage.request.post(`${origin!.replace(/\/$/, "")}/api/commit`, {
    data: {
      requestId: `remote-smoke-cleanup-${randomUUID()}`,
      expectedRevision: snapshot.revision,
      files,
      protocolVersion: 2,
      ...(snapshot.attachments ? { attachments } : {}),
    },
  });
  if (!response.ok()) throw new Error(`远程临时验收笔记清理失败（${response.status()}）`);
}

try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: process.env.ZFY_REMOTE_ALLOW_SELF_SIGNED === "1",
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const response = await page.goto(origin.replace(/\/$/, "") + "/", {
    waitUntil: "domcontentloaded",
  });
  if (!response?.ok()) throw new Error(`远程首页返回 ${response?.status() ?? "未知状态"}`);
  const base = origin.replace(/\/$/, "");
  if (process.env.ZFY_REMOTE_EXPECT_AI === "1") {
    const health = await page.request.get(`${base}/api/health`);
    if (!health.ok() || (await health.json()).aiConfigured !== true)
      throw new Error("远程健康接口未识别到 AI 模型配置");
  }
  const manifest = await page.request.get(`${base}/manifest.webmanifest`);
  if (!manifest.ok() || (await manifest.json()).display !== "standalone")
    throw new Error("远程 PWA manifest 未生效");
  if (!/manifest\+json|json/.test(manifest.headers()["content-type"] ?? ""))
    throw new Error("远程 PWA manifest MIME 类型错误");
  const icon = await page.request.get(`${base}/icon.svg`);
  if (!icon.ok() || !/image\/svg\+xml/.test(icon.headers()["content-type"] ?? ""))
    throw new Error("远程 PWA 图标未生效");
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByText("原文 / SOURCE").waitFor();
  cleanupPage = page;
  await page.getByText(/已同步本地测试服务|已载入服务器上的外部文件修改/).waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("button"))
      .some((button) => button.textContent?.trim() === "＋ 笔记" && !button.disabled),
    undefined,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "＋ 笔记" }).click();
  await page.getByLabel("文档标题").fill(temporaryTitle);
  await page.getByLabel("添加本机附件").setInputFiles({
    name: "remote-pixel.gif",
    mimeType: "image/gif",
    buffer: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"),
  });
  await page.getByText("附件和引用已保存本机 · 待同步").waitFor();
  await page.getByRole("button", { name: "同步并检查外部变更" }).click();
  await page.getByText("已同步本地测试服务").waitFor();
  await page.locator(".attachment-media img").waitFor();
  const secondContext = await browser.newContext({
    ignoreHTTPSErrors: process.env.ZFY_REMOTE_ALLOW_SELF_SIGNED === "1",
  });
  try {
    const secondPage = await secondContext.newPage();
    secondPage.setDefaultTimeout(20_000);
    await secondPage.goto(origin.replace(/\/$/, "") + "/", { waitUntil: "domcontentloaded" });
    await secondPage.locator('input[type="password"]').fill(password);
    await secondPage.getByRole("button", { name: "登录" }).click();
    await secondPage.getByText("原文 / SOURCE").waitFor();
    const remoteNote = secondPage.getByRole("button", { name: new RegExp(temporaryTitle) });
    await remoteNote.waitFor();
    await remoteNote.click();
    await secondPage.locator(".attachment-media img").waitFor();
  } finally {
    await secondContext.close();
  }
  if (process.env.ZFY_REMOTE_AI_SMOKE === "1") {
    const question = process.env.ZFY_REMOTE_AI_QUESTION ?? "第二大脑";
    await page.getByRole("button", { name: /管理员与每日整理/ }).click();
    await page.getByLabel("询问知识管理员").fill(question);
    await page.getByRole("button", { name: "获取带引用的回答" }).click();
    await page.locator("article.manager-answer").waitFor({ timeout: 60_000 });
    if (!(await page.locator("article.manager-answer code").count()))
      throw new Error("远程 AI 回答缺少原文引用");
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  if (overflow) throw new Error("390px 视口出现横向溢出");
  console.log(`远程浏览器 smoke 通过：${origin}`);
  await context.close();
} finally {
  await removeTemporaryNote();
  await browser.close();
}
