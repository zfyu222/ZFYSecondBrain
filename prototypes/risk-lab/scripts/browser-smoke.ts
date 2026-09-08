import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const origin = process.env.ZFY_BROWSER_SMOKE_ORIGIN ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  const health = await page.request.get(`${origin}/api/health`);
  assert.equal(health.ok(), true, "本机服务健康检查未通过");
  const status = await health.json() as { prototype?: unknown; protocolVersion?: unknown };
  assert.equal(status.prototype, true, "目标不是隔离原型服务");
  assert.equal(status.protocolVersion, 2, "原型协议版本不匹配");

  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  assert.equal(await page.title(), "第二大脑 · 技术实验室");
  await page.getByText("原文 / SOURCE").waitFor();
  await page.getByText("验证工具与原始文件").click();
  const exportButton = page.getByRole("button", { name: "导出标准 Markdown" });
  await exportButton.waitFor();
  const download = page.waitForEvent("download");
  await exportButton.click();
  const exported = await download;
  assert.match(exported.suggestedFilename(), /\.standard\.md$/);
  const exportedPath = await exported.path();
  assert.ok(exportedPath, "浏览器没有生成标准 Markdown 文件");
  assert.notEqual((await readFile(exportedPath, "utf8")).trim(), "");
  await page.getByRole("button", { name: "管理员与每日整理" }).click();
  await page.getByRole("heading", { name: "询问知识管理员" }).waitFor();
  const question = page.getByLabel("询问知识管理员");
  await question.fill("本地服务");
  const submit = page.getByRole("button", { name: "获取带引用的回答" });
  await submit.waitFor();
  assert.equal(await submit.isEnabled(), true, "已配置模型时提问按钮应可用");

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${origin}/`, { waitUntil: "networkidle" });
  await mobile.getByText("原文 / SOURCE").waitFor();
  await mobile
    .getByRole("button", { name: "同步并检查外部变更" })
    .waitFor();
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    true,
    "390px 窄屏出现整页横向溢出",
  );
  await mobile.close();
  console.log(`浏览器 smoke 通过：${origin}`);
} finally {
  await browser.close();
}
