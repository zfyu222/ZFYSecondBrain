import { chromium } from "@playwright/test";

const origin = process.env.ZFY_REMOTE_ORIGIN;
const password = process.env.ZFY_REMOTE_PASSWORD;
if (!origin || !password)
  throw new Error("请设置 ZFY_REMOTE_ORIGIN 和 ZFY_REMOTE_PASSWORD 后再运行远程 smoke");

const browser = await chromium.launch({ channel: "chrome", headless: true });
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
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByText("原文 / SOURCE").waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  if (overflow) throw new Error("390px 视口出现横向溢出");
  console.log(`远程浏览器 smoke 通过：${origin}`);
  await context.close();
} finally {
  await browser.close();
}
