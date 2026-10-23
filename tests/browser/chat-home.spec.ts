import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(
  process.env.BAI_CHAT_HOME_QA !== "1",
  "Requires isolated chat home QA",
);
const shots = resolve(".local-data/qa-appearance/screenshots/chat-home");

test.beforeAll(async ({ request }) => {
  const data = await request.get("/api/v1/settings/data").then((r) => r.json());
  expect(data.directory).toContain(process.env.BAI_QA_DATA_MARKER || "qa-appearance");
  mkdirSync(shots, { recursive: true });
});

test("chat home keeps its single layout in both themes without creating plans or sending drafts", async ({
  page,
  request,
}) => {
  const before = await request
    .get("/api/v1/settings/data")
    .then((r) => r.json());
  const writes: string[] = [],
    errors: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" && req.url().includes("/api/v1/"))
      writes.push(req.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "展开侧栏", exact: true }),
  ).toBeVisible();
  for (const theme of ["cream", "warm-dark"]) {
    await page.getByRole("button", { name: "连接与设置", exact: true }).click();
    await page.getByRole("tab", { name: "外观", exact: true }).click();
    await page
      .getByRole("radio", {
        name: theme === "cream" ? "奶油杏 · 浅色" : "暖灰棕 · 深色",
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await expect(page.locator(".main-panel")).toHaveCSS(
      "background-color",
      theme === "cream" ? "rgb(255, 252, 248)" : "rgb(45, 41, 37)",
    );
    await expect(
      page.getByRole("heading", { name: "今天想做些什么？", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".new-chat-date")).toBeVisible();
    await expect(page.locator(".chat-home")).toHaveCount(0);
    await page.screenshot({
      path: resolve(shots, `${theme}.png`),
      animations: "disabled",
    });
  }
  const input = page.getByLabel("发送给XiaoXi的消息");
  await input.fill("保留我的草稿");
  await expect(input).toBeFocused();
  await page.reload();
  await expect(input).toHaveValue("保留我的草稿");
  await expect(
    page.getByRole("heading", { name: "今天想做些什么？", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 710 });
  const home = await page.locator(".new-chat-welcome").boundingBox();
  const panel = await page.locator(".chat-main").boundingBox();
  const composer = await page.locator(".composer-area").boundingBox();
  expect(home!.y + home!.height).toBeLessThanOrEqual(composer!.y);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(
    panel!.y + panel!.height,
  );
  await page.setViewportSize({ width: 720, height: 650 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const bounds = await page.locator(".new-chat-welcome").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  const after = await request
    .get("/api/v1/settings/data")
    .then((r) => r.json());
  expect(after.counts).toEqual(before.counts);
});
