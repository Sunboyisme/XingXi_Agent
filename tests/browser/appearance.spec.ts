import { test, expect, type Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(
  process.env.BAI_APPEARANCE_QA !== "1",
  "Requires isolated appearance data",
);
const shots = resolve(".local-data/qa-appearance/screenshots");
test.beforeAll(async ({ request }) => {
  const data = await request.get("/api/v1/settings/data").then((r) => r.json());
  expect(data.directory).toContain(process.env.BAI_QA_DATA_MARKER || "qa-appearance");
  mkdirSync(shots, { recursive: true });
});
test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

async function contrastOf(locator: Locator) {
  return locator.evaluate((element) => {
    const rgb = (value: string) =>
      (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = (value: string) =>
      rgb(value)
        .map((c) => {
          const s = c / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        })
        .reduce((total, c, i) => total + c * [0.2126, 0.7152, 0.0722][i], 0);
    let background = element as Element | null;
    while (
      background &&
      ["rgba(0, 0, 0, 0)", "transparent"].includes(
        getComputedStyle(background).backgroundColor,
      )
    )
      background = background.parentElement;
    const a = luminance(getComputedStyle(element).color),
      b = luminance(
        getComputedStyle(background || document.documentElement)
          .backgroundColor,
      );
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test("both themes persist, synchronize across windows and keep dialogs readable", async ({
  page,
  context,
}) => {
  await expect(page.locator(".main-panel")).toHaveCSS(
    "background-color",
    "rgb(45, 41, 37)",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "warm-dark");
  await page.screenshot({ path: resolve(shots, "dark-home-default.png") });
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "外观", exact: true }).click();
  await page.getByRole("radio", { name: "暖灰棕 · 深色", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "warm-dark");
  await expect(page.locator(".settings-tabs")).toHaveCSS(
    "background-color",
    "rgb(59, 52, 45)",
  );
  await expect(page.getByRole("tab", { name: "外观", exact: true })).toHaveCSS(
    "background-color",
    "rgb(45, 41, 37)",
  );
  expect(
    await contrastOf(page.getByRole("tab", { name: "外观", exact: true })),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    await contrastOf(page.getByRole("tab", { name: "工具", exact: true })),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    await contrastOf(page.getByRole("heading", { name: "让界面更合眼缘" })),
  ).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: resolve(shots, "dark-appearance.png") });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "warm-dark");
  await expect(page.locator(".main-panel")).toHaveCSS(
    "background-color",
    "rgb(45, 41, 37)",
  );
  if (await page.getByRole("button", { name: "收起侧栏", exact: true }).count())
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  expect(
    await contrastOf(page.locator(".welcome-date")),
  ).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: resolve(shots, "dark-home.png") });
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await page.getByRole("menuitem", { name: /普通计划/ }).click();
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await expect(page.locator(".datetime-popover")).toHaveCSS(
    "background-color",
    "rgb(53, 48, 42)",
  );
  expect(
    await contrastOf(page.locator(".calendar-heading > strong")),
  ).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: resolve(shots, "dark-date-dialog.png") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.locator("html")).toHaveAttribute(
    "data-theme",
    "warm-dark",
  );
  await other.getByRole("button", { name: "连接与设置", exact: true }).click();
  await other.getByRole("tab", { name: "外观", exact: true }).click();
  await other
    .getByRole("radio", { name: "奶油杏 · 浅色", exact: true })
    .check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cream");
  await expect(page.locator(".main-panel")).toHaveCSS(
    "background-color",
    "rgb(255, 252, 248)",
  );
  await other.setViewportSize({ width: 720, height: 650 });
  expect(
    await other.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await other.screenshot({
    path: resolve(shots, "cream-appearance-narrow.png"),
  });
  await other.close();
});

test("chat artwork is removed while the navigation character remains interactive", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".chat-main .bai-avatar")).toHaveCount(0);
  const avatar = page.getByRole("button", {
    name: "点击头像新建对话",
    exact: true,
  });
  await expect(avatar.locator(".bai-avatar")).toBeVisible();
  await avatar.click();
  await expect(avatar).toHaveAttribute("data-reaction", "happy");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "外观", exact: true }).click();
  await page.getByRole("radio", { name: "暖灰棕 · 深色", exact: true }).check();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "QA 外观检查", exact: true }).click();
  await expect(page.locator(".message.assistant")).toContainText(
    "先安排最重要的一件事",
  );
  await expect(page.locator(".chat-main .bai-avatar")).toHaveCount(0);
  await expect(page.locator(".message.assistant .message-avatar")).toHaveCount(
    0,
  );
  await expect(avatar.locator(".bai-avatar")).toBeVisible();
  expect(
    await contrastOf(page.locator(".message.assistant .markdown > p").first()),
  ).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: resolve(shots, "dark-conversation.png") });
  await expect(page.locator(".message.assistant .message-body")).toHaveCSS(
    "width",
    await page
      .locator(".message.assistant")
      .evaluate((e) => getComputedStyle(e).width),
  );
  expect(errors).toEqual([]);
});
