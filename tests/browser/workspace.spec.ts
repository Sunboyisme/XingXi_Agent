import { test, expect } from "@playwright/test";

test.skip(process.env.BAI_UI_QA !== "1", "Requires isolated UI review data");

test("workspace remains usable at desktop and narrow window sizes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "收起侧栏", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".chat-sidebar .new-chat-button")).toBeVisible();
  await expect(page.locator(".home-continuity")).toHaveCount(0);
  const toggle = page.getByRole("button", { name: "收起侧栏", exact: true });
  await expect(page.locator(".window-titlebar .sidebar-toggle")).toBeVisible();
  const initialToggle = await toggle.boundingBox();
  expect(initialToggle!.y).toBeLessThan(40);
  expect(initialToggle!.x).toBeLessThan(130);
  await page.screenshot({
    path: ".local-data/ui-review-20261017/home-desktop.png",
  });

  for (const width of [1024, 770, 720, 520]) {
    await page.setViewportSize({ width, height: width === 1024 ? 600 : 800 });
    if (width === 720) {
      await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const composer = page.getByLabel("发送给XiaoXi的消息");
    await composer.fill("保留这条草稿");
    const bounds = await composer.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const send = await page
      .getByRole("button", { name: "发送消息", exact: true })
      .boundingBox();
    expect(send!.x + send!.width).toBeLessThanOrEqual(width);
    expect(send!.y + send!.height).toBeLessThanOrEqual(
      width === 1024 ? 600 : 800,
    );
    const footer = await page
      .getByRole("button", { name: "关于这个空间", exact: true })
      .boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(
      width === 1024 ? 600 : 800,
    );
    await page.screenshot({
      path: `.local-data/ui-review-20261017/home-${width}.png`,
    });
  }
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "开启新对话", exact: true }).click();
  await expect(page.getByLabel("发送给XiaoXi的消息")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("WeChat separates connection, uncertain delivery, reminders and actions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let status = {
    enabled: true,
    bound: true,
    reminders_enabled: true,
    phase: "connected",
    qr_image: "",
    error: "发送结果未知，请到微信确认；未自动重发。",
    deliveries: [
      {
        id: "review-delivery",
        status: "uncertain",
        error: "发送结果未知，请到微信确认；未自动重发。",
        created_at: "2026-10-17T05:00:00Z",
      },
    ],
  };
  await page.route("**/api/v1/wechat/**", async (route) => {
    const request = route.request();
    if (request.url().endsWith("/options")) {
      status = { ...status, ...request.postDataJSON() };
      status.phase = status.enabled ? "connected" : "paused";
    }
    await route.fulfill({ json: status });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("button", { name: "管理微信连接" }).click();
  const section = page
    .getByRole("dialog")
    .getByRole("region", { name: "微信连接" });
  await expect(section.getByRole("status")).toHaveText("已连接");
  await expect(section.getByRole("alert")).toContainText("未自动重发");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({
    path: ".local-data/ui-review-20261017/wechat-desktop.png",
  });
  await section.getByRole("checkbox").click();
  await expect(section.getByRole("checkbox")).not.toBeChecked();
  await section.getByRole("button", { name: "暂停连接" }).click();
  await expect(section.getByRole("status")).toHaveText("已暂停");
  await expect(section.getByRole("checkbox")).toBeDisabled();
  await section.getByRole("button", { name: "恢复连接" }).click();
  await section.locator("summary").click();
  await expect(
    section.getByText("送达结果未知", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 720, height: 800 });
  await expect(page.locator(".chat-sidebar")).toBeHidden();
  await section.scrollIntoViewIfNeeded();
  const bounds = await section.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
  await section.screenshot({
    path: ".local-data/ui-review-20261017/wechat-narrow.png",
  });
  expect(errors).toEqual([]);
});

test("menus create the right content and chat history stays on the chat page", async ({
  page,
}) => {
  await page.goto("/");
  const menu = page.getByRole("menubar", { name: "应用菜单" });
  await expect(menu).toBeVisible();
  await page.getByRole("button", { name: "学习", exact: true }).click();
  await expect(page.locator(".chat-sidebar")).toBeHidden();
  await expect(page.locator(".sidebar-toggle")).toHaveCount(0);
  expect((await page.locator(".sidebar").boundingBox())!.width).toBe(76);
  await menu.getByRole("menuitem", { name: "文件", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "新建学习目标", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("你想学什么");
  await page.keyboard.press("Escape");
  await menu.getByRole("menuitem", { name: "文件", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("安排一件小事");
  await expect(page.locator(".chat-sidebar")).toBeHidden();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+1");
  await expect(page.locator(".chat-sidebar")).toBeVisible();
  await page.keyboard.press("Control+2");
  await expect(page.locator(".chat-sidebar")).toBeHidden();
  await page.keyboard.press("Control+3");
  await expect(page.locator(".chat-sidebar")).toBeHidden();
  await page.setViewportSize({ width: 800, height: 440 });
  await menu.getByRole("menuitem", { name: "帮助", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "关于 XiaoXi", exact: true })
    .click();
  const about = page.getByRole("dialog");
  await expect(about.getByRole("button", { name: /^退出/ })).toHaveCount(0);
  const confirm = about.getByRole("button", { name: "知道了", exact: true });
  await expect(confirm).toBeInViewport();
  const bounds = await about.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(440);
  await confirm.click();
  await page.keyboard.press("F1");
  await expect(page.getByRole("dialog")).toContainText("Ctrl+N");
});

test("edit menu restores the selected input and pastes through React", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByLabel("发送给XiaoXi的消息");
  await input.fill("原来的草稿");
  await input.selectText();
  // A synthetic clipboard verifies the edit flow without touching the OS clipboard.
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "菜单粘贴验证" },
    }),
  );
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "编辑", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^粘贴/ }).click();
  await expect(input).toHaveValue("菜单粘贴验证");
  await expect(input).toBeFocused();
  await page
    .getByRole("menubar")
    .getByRole("menuitem", { name: "编辑", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^全选/ }).click();
  const selection = await input.evaluate((element: HTMLTextAreaElement) => [
    element.selectionStart,
    element.selectionEnd,
  ]);
  expect(selection).toEqual([0, "菜单粘贴验证".length]);
});
