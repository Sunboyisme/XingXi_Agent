import { test, expect } from "@playwright/test";
import { selectCalendarDate } from "./helpers/calendarPicker";
test.describe.configure({ mode: "default" });
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  (page as any).testErrors = errors;
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "连接与设置", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page
    .getByRole("button", { name: "点击头像新建对话", exact: true })
    .click();
});
test.afterEach(async ({ page }) =>
  expect((page as any).testErrors).toEqual([]),
);

test("small window keeps Chinese title and main actions accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1262, height: 624 });
  const box = await page
    .getByRole("region", { name: "新对话欢迎" })
    .getByRole("heading")
    .boundingBox();
  expect(box?.y).toBeGreaterThanOrEqual(56);
  const composer = page.getByLabel("发送给XiaoXi的消息");
  await composer.fill("检查换行");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("检查换行\n");
  const model = page.getByRole("button", { name: "选择模型", exact: true });
  await model.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(model).toBeFocused();
  const add = page.locator('.composer button[aria-label="更多功能"]');
  await add.click();
  const mcp = page.getByRole("menuitem", { name: "MCP 工具", exact: true });
  await mcp.hover();
  await expect(page.getByRole("menuitem", { name: /查询天气/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await expect(composer).toHaveValue("检查换行\n");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("separate sidebar toggle preserves draft, navigation and saved preference", async ({
  page,
}) => {
  const draft = page.getByLabel("发送给XiaoXi的消息");
  await draft.fill("先留在这里，等我想清楚再发送");
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  const collapse = page.getByRole("button", { name: "收起侧栏", exact: true });
  await expect(page.locator(".chat-main .bai-avatar")).toHaveCount(1);
  await expect(page.locator(".navigation-rail .bai-avatar")).toBeVisible();
  await expect(collapse).toBeVisible();
  await expect(page.locator(".chat-sidebar .new-chat-button")).toBeVisible();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await collapse.click();
  await expect(
    page.getByRole("button", { name: "展开侧栏", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(draft).toHaveValue("先留在这里，等我想清楚再发送");
  const rail = await page.locator(".sidebar").boundingBox();
  expect(rail?.width).toBeLessThan(100);
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "记忆", exact: true, level: 1 }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "展开侧栏", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "收起侧栏", exact: true }),
  ).toBeVisible();
  expect((await page.locator(".sidebar").boundingBox())?.width).toBeGreaterThan(
    170,
  );
  await expect(page.locator(".profile,.local-indicator")).toHaveCount(0);
  await expect(page.getByText("随时接着往前走", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator(".app-topbar")).not.toContainText("我的空间");
  await expect(
    page.getByText("Enter 发送 · Shift + Enter 换行", { exact: true }),
  ).toHaveCount(0);
});

test("MCP toolbox hides built-ins and opens configuration", async ({
  page,
  request,
}) => {
  if (process.env.BAI_QA_DATA_MARKER === "qa-017a") {
    const data = await request
      .get("/api/v1/settings/data")
      .then((response) => response.json());
    expect(data.directory).toContain("qa-017a");
    for (const server of await request
      .get("/api/v1/mcp/servers")
      .then((response) => response.json()))
      await request.delete(`/api/v1/mcp/servers/${server.id}`);
  }
  const toolbox = page.locator('.composer button[aria-label="更多功能"]');
  await toolbox.click();
  await page.getByRole("menuitem", { name: "MCP 工具", exact: true }).hover();
  await expect(
    page.getByRole("menuitem", { name: /计算器|查询天气/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText("还没有配置 MCP 工具", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(toolbox).toBeFocused();
});

test("configure own compatible API and test connection", async ({ page }) => {
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "模型连接", exact: true }).click();
  await page
    .getByRole("button", { name: /^编辑连接 / })
    .first()
    .click();
  await page
    .getByLabel("接口地址", { exact: true })
    .fill(process.env.BAI_MOCK_URL || "http://127.0.0.1:8877/v1");
  await page.getByLabel("模型名称", { exact: true }).fill("mock-test");
  await page.getByRole("button", { name: "保存并测试", exact: true }).click();
  await expect(
    page.getByText("模型接口连接成功", { exact: true }),
  ).toBeVisible();
});

test("new conversation stream saves final answer and tool memory", async ({
  page,
}) => {
  await page.getByLabel("发送给XiaoXi的消息").fill("请记住我喜欢先看例子");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page
      .locator(".message.assistant")
      .getByText("工具已经执行，结果已保存。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(
    page.getByText("用户喜欢先看例子再学习理论", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(
    page.getByText("用户喜欢先看例子再学习理论", { exact: true }),
  ).toBeVisible();
});

test("agent calls multiple utility tools and restores results after reload", async ({
  page,
}) => {
  await page.getByRole("radio", { name: "智能体", exact: true }).click();
  await page
    .getByLabel("发送给XiaoXi的消息")
    .fill("帮我计算并换算单位，再查一下日期。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "工具调用结果" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "工具调用结果" }).click();
  await expect(page.getByText("结果：244.80", { exact: true })).toBeVisible();
  await expect(
    page.getByText("结果：8.04672 km", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page
    .locator(".conversation-link > button:first-child")
    .filter({ hasText: "帮我计算并换算单位" })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "工具调用结果" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "工具调用结果" }).click();
  await expect(page.getByText("结果：244.80", { exact: true })).toBeVisible();
});

test("course, teaching, feedback, next node and reload progress", async ({
  page,
}) => {
  await page.getByRole("button", { name: "学习", exact: true }).click();
  await page.getByRole("button", { name: "创建学习", exact: true }).click();
  // New goals are shaped through the guided intake conversation.
  const intake = page.getByRole("textbox", { name: "学习目标对话" });
  await intake.fill("我想学HTML，能够理解页面结构");
  await page.getByRole("button", { name: "发送回答", exact: true }).click();
  await expect(
    page.getByText("你目前有什么基础？", { exact: true }),
  ).toBeVisible();
  await intake.fill("零基础，尚未学习编程");
  await page.getByRole("button", { name: "发送回答", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "学习目标摘要" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认并生成学习路线" }).click();
  await expect(
    page.getByRole("heading", { name: "HTML隔离验收 · 认识基础", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "开始这个知识点", exact: true })
    .click();
  await expect(page.getByLabel("练习回答")).toBeVisible();
  await page
    .getByLabel("练习回答")
    .fill("概念描述事物，例如前端页面中的结构。");
  await page.getByRole("button", { name: "发送回答", exact: true }).click();
  await expect(
    page.getByText("这次练习通过了", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "学习", exact: true }).click();
  // The learning home lists goals; progress resumes from the goal card.
  await page.getByRole("button", { name: "继续学习" }).first().click();
  await expect(
    page.getByText("这次练习通过了", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: /HTML隔离验收 · 应用方法/ }).click();
  await expect(
    page.getByRole("heading", { name: "HTML隔离验收 · 应用方法", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: ".local-data/review/learning-browser.png" });
});

test("manual memories can be created, edited and deleted", async ({ page }) => {
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await page.getByRole("button", { name: "添加记忆", exact: true }).click();
  await page.getByLabel("想记住什么").fill("浏览器测试：正在写个人 Agent");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  const card = page
    .locator(".memory-card")
    .filter({ hasText: "浏览器测试：正在写个人 Agent" });
  await card.getByRole("button", { name: "编辑记忆", exact: true }).click();
  await page.getByLabel("想记住什么").fill("浏览器测试：记忆已修改");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  const changed = page
    .locator(".memory-card")
    .filter({ hasText: "浏览器测试：记忆已修改" });
  await changed.getByRole("button", { name: "删除记忆", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "删除记忆", exact: true })
    .click();
  await expect(
    page.getByText("浏览器测试：记忆已修改", { exact: true }),
  ).toHaveCount(0);
});

test("manual plan with reminder can be saved, edited and completed", async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const initialTitle = `浏览器测试：明天学习-${stamp}`;
  const editedTitle = `浏览器测试：已调整学习时间-${stamp}`;
  if (process.env.BAI_QA_DATA_MARKER === "qa-017a") {
    const data = await request
      .get("/api/v1/settings/data")
      .then((response) => response.json());
    expect(data.directory).toContain("qa-017a");
    for (const plan of await request
      .get("/api/v1/plans")
      .then((response) => response.json())) {
      if (plan.title.startsWith("浏览器测试："))
        await request.delete(`/api/v1/plans/${plan.id}`);
    }
  }
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await page.getByRole("menuitem", { name: /普通计划/ }).click();
  await page.getByLabel("计划名称").fill(initialTitle);
  const tomorrow = new Date(Date.now() + 32 * 3600000)
    .toISOString()
    .slice(0, 10);
  await page.getByLabel("指定时间", { exact: true }).check();
  await selectCalendarDate(page, "开始", tomorrow, "09:00");
  await selectCalendarDate(page, "结束", tomorrow, "10:00");
  await page.getByLabel("设置提醒时间", { exact: true }).check();
  await selectCalendarDate(page, "提醒时间", tomorrow, "08:45");
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const day = page.locator(
    `.plan-day:has([aria-label="${tomorrow} 添加计划"])`,
  );
  async function openDay(title: string) {
    const more = day.getByRole("button", {
      name: `查看 ${tomorrow} 的全部计划`,
      exact: true,
    });
    if (await more.isVisible()) await more.click();
    else await day.getByRole("button", { name: new RegExp(title) }).click();
  }
  await openDay(initialTitle);
  await page
    .getByRole("button", {
      name: `编辑 ${initialTitle}`,
      exact: true,
    })
    .click();
  await page.getByLabel("计划名称").fill(editedTitle);
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openDay(editedTitle);
  await page
    .getByRole("button", {
      name: `完成 ${editedTitle} ${tomorrow}`,
      exact: true,
    })
    .click();
  expect(
    (await request.get("/api/v1/plans").then((r) => r.json())).find(
      (plan: any) => plan.title === editedTitle,
    ).status,
  ).toBe("completed");
});
