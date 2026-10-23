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
  if (await page.getByRole("button", { name: "收起侧栏", exact: true }).count())
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
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
      page.getByRole("heading", { name: "今日安排", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "上次任务", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".chat-home [aria-pressed]")).toHaveCount(0);
    const bounds = await page.locator(".chat-home").boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280);
    await page.screenshot({
      path: resolve(shots, `${theme}.png`),
      animations: "disabled",
    });
  }
  const input = page.getByLabel("发送给XiaoXi的消息");
  await input.fill("保留我的草稿");
  await page.getByRole("button", { name: "添加安排", exact: true }).click();
  await expect(input).toHaveValue(
    "帮我安排今天的时间。先问问我今天最想完成什么，再给出一个轻松可行的安排。",
  );
  await expect(input).toBeFocused();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "上次任务", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 710 });
  const home = await page.locator(".chat-home").boundingBox();
  const panel = await page.locator(".chat-main").boundingBox();
  expect(home!.y + home!.height).toBeLessThanOrEqual(panel!.y + panel!.height);
  await page.setViewportSize({ width: 720, height: 650 });
  await page.locator(".chat-home").scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const bounds = await page.locator(".chat-home").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
  await page.locator(".home-continue-list button").nth(1).click();
  await expect(page.locator(".message.assistant")).toBeVisible();
  await expect(page.locator(".chat-home")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  const after = await request
    .get("/api/v1/settings/data")
    .then((r) => r.json());
  expect(after.counts).toEqual(before.counts);
});

test("a failed agenda request has an honest fallback and all-day rows render correctly", async ({
  page,
}) => {
  await page.route("**/api/v1/plans?*", (route) =>
    route.fulfill({ status: 503, json: { detail: "QA: offline" } }),
  );
  await page.goto("/");
  await expect(page.getByText("暂时没有读到计划")).toBeVisible();
  await page.unroute("**/api/v1/plans?*");
  await page.route("**/api/v1/plans?*", (route) =>
    route.fulfill({
      json: [
        {
          id: "qa-only",
          title: "QA 全天计划",
          status: "planned",
          all_day: true,
          start: "2026-10-19T00:00:00+08:00",
        },
        {
          id: "qa-done",
          title: "QA 已完成",
          status: "completed",
          all_day: true,
          start: "2026-10-19T00:00:00+08:00",
        },
      ],
    }),
  );
  await page.reload();
  await expect(page.locator(".home-agenda")).toContainText("全天");
  await expect(page.getByText("QA 已完成")).toHaveCount(0);
  await page.getByRole("button", { name: /QA 全天计划/ }).click();
  await expect(
    page.getByRole("button", { name: "添加计划", exact: true }),
  ).toBeVisible();
});
