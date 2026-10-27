import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "default" });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "连接与设置", exact: true }),
  ).toBeVisible();
});

test("MCP and skills panels never stay open together", async ({ page }) => {
  const mcp = page.getByRole("button", { name: "MCP 工具", exact: true });
  const skills = page.getByRole("button", { name: "技能", exact: true });
  await mcp.click();
  await expect(page.getByRole("menuitem", { name: "配置 MCP" })).toBeVisible();
  await skills.click();
  await expect(page.getByRole("menuitem", { name: "管理技能" })).toBeVisible();
  await expect(page.locator(".toolbox-menu")).toHaveCount(1);
});

test("an unsent draft survives leaving the chat page", async ({ page }) => {
  const composer = page.getByLabel("发送给XiaoXi的消息");
  await composer.fill("离开页面也要留下这段草稿");
  await page.getByRole("button", { name: "学习", exact: true }).click();
  await page.locator(".learning-page").waitFor();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(composer).toHaveValue("离开页面也要留下这段草稿");
});

test("authentication errors keep the message aligned and offer interface settings", async ({
  page,
}) => {
  await page.route("**/api/v1/conversations", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "接口认证失败，请检查密钥与接口地址。",
          }),
        })
      : route.continue(),
  );
  await page.getByLabel("发送给XiaoXi的消息").fill("触发接口错误");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const notice = page.locator(".error-notice");
  await expect(notice).toContainText("接口认证失败");
  expect(
    await notice
      .locator(".error-notice-text")
      .evaluate((element) => getComputedStyle(element).textAlign),
  ).toBe("left");
  await notice.getByRole("button", { name: "配置接口", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设置", exact: true }),
  ).toBeVisible();
});

test("learning failures appear as a bottom toast", async ({ page }) => {
  await page.route("**/api/v1/learning/intakes", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "学习草稿暂时无法读取，请稍后重试。",
          }),
        })
      : route.continue(),
  );
  await page.getByRole("button", { name: "学习", exact: true }).click();
  const toast = page.locator(".app-toast.is-error");
  await expect(toast).toContainText("学习草稿暂时无法读取");
  const box = await toast.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport && box.y > viewport.height * 0.7).toBe(true);
  await page.screenshot({
    path: ".local-data/feedback-014b-review/learning-toast.png",
  });
});

test("a clear habit is remembered even when the model does not call the tool", async ({
  page,
}) => {
  expect(
    (
      await page.request.patch("/api/v1/settings/memory", {
        data: { memory_mode: "auto" },
      })
    ).ok(),
  ).toBeTruthy();
  const existing = await page.request.get("/api/v1/memories");
  for (const item of await existing.json())
    await page.request.delete(`/api/v1/memories/${item.id}`);
  const composer = page.getByLabel("发送给XiaoXi的消息");
  await composer.fill("我有每天学英语和读书的习惯");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message.assistant .markdown").last()).toBeVisible(
    {
      timeout: 20000,
    },
  );
  await expect(page.locator(".memory-saved-notice")).toContainText("已记住", {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(
    page
      .locator(".memory-content")
      .filter({ hasText: "用户有每天学英语和读书的习惯" }),
  ).toBeVisible();
});

test("an option label renders above its poster image", async ({ page }) => {
  const composer = page.getByLabel("发送给XiaoXi的消息");
  await composer.fill("你好");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message.assistant .markdown").last()).toBeVisible(
    {
      timeout: 20000,
    },
  );
  const layout = await page.evaluate(() => {
    const host = document.querySelector(".message.assistant .markdown");
    if (!host) throw new Error("no markdown host");
    const paragraph = document.createElement("p");
    paragraph.innerHTML =
      '<strong>方案一：</strong><span class="output-picture"><span class="picture-trigger"><img alt="海报" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="width:120px;height:160px;display:block" /></span></span>';
    host.appendChild(paragraph);
    const image = paragraph.querySelector(".output-picture")!;
    const label = paragraph.querySelector("strong")!;
    return {
      display: getComputedStyle(paragraph).display,
      direction: getComputedStyle(paragraph).flexDirection,
      labelBottom: label.getBoundingClientRect().bottom,
      imageTop: image.getBoundingClientRect().top,
    };
  });
  expect(layout.display).toBe("flex");
  expect(layout.direction).toBe("column");
  expect(layout.labelBottom).toBeLessThanOrEqual(layout.imageTop + 1);
  await page.screenshot({
    path: ".local-data/feedback-014b-review/poster-label.png",
  });
});
