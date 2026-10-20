import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { selectCalendarDate } from "./helpers/calendarPicker";

test.skip(process.env.BAI_013_QA !== "1", "Requires isolated 0.1.3 QA data");
test.describe.configure({ mode: "serial" });
const shots = ".local-data/qa-0.1.3/screenshots";
test.beforeAll(async ({ request }) => {
  mkdirSync(shots, { recursive: true });
  const previous = await request.get("/api/v1/settings").then((r) => r.json());
  for (const provider of previous.providers)
    await request.delete(`/api/v1/settings/providers/${provider.id}`);
  const response = await request.put("/api/v1/settings", {
    data: {
      model_url: process.env.BAI_MOCK_URL || "http://127.0.0.1:8893/v1",
      model_name: "mock-test",
      model_key: "synthetic-013-key",
      vision_enabled: true,
    },
  });
  expect(response.ok()).toBe(true);
  for (const event of await request
    .get("/api/v1/calendar/events")
    .then((r) => r.json())) {
    if (event.title.startsWith("本地"))
      await request.delete(`/api/v1/calendar/events/${event.id}`);
  }
  for (const server of await request
    .get("/api/v1/mcp/servers")
    .then((r) => r.json())) {
    if (server.name.startsWith("013 本地验收"))
      await request.delete(`/api/v1/mcp/servers/${server.id}`);
  }
});
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  (page as any).testErrors = errors;
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "计划", exact: true }),
  ).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect((page as any).testErrors).toEqual([]);
});

test("calendar creates, restores and completes a plan with one linked reminder", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await page.getByRole("menuitem", { name: /普通计划/ }).click();
  await page.getByLabel("计划名称", { exact: true }).fill("本地验收：跨日计划");
  await selectCalendarDate(page, "开始", "2026-10-20");
  await selectCalendarDate(page, "结束（含当天）", "2026-10-21");
  await page.getByLabel("设置提醒时间", { exact: true }).check();
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  let events = await request
    .get("/api/v1/calendar/events")
    .then((r) => r.json());
  const event = events.find((e: any) => e.title === "本地验收：跨日计划");
  expect(event.end).toBe("2026-10-22");
  await page.reload();
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "本地验收：跨日计划", exact: true }),
  ).toHaveCount(2);
  await page.screenshot({ path: `${shots}/calendar-month.png` });
  await expect(
    page.getByRole("button", { name: "周历", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 720, height: 650 });
  await expect(page.locator(".plan-calendar")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: `${shots}/calendar-narrow.png` });
  await page
    .locator(".plan-month-grid .day-event")
    .filter({ hasText: "本地验收：跨日计划" })
    .first()
    .click();
  await page
    .getByRole("button", { name: "编辑 本地验收：跨日计划", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("看看这项计划");
  await page.getByRole("button", { name: "完成事项", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  events = await request.get("/api/v1/calendar/events").then((r) => r.json());
  expect(events.find((e: any) => e.id === event.id).status).toBe("completed");
  const reminders = await request
    .get("/api/v1/reminders")
    .then((r) => r.json());
  expect(reminders.find((r: any) => r.id === event.reminder_id).status).toBe(
    "cancelled",
  );
});

test("imports a disabled skill and produces a downloadable file through the agent", async ({
  page,
  request,
}) => {
  const existing = await request.get("/api/v1/skills").then((r) => r.json());
  for (const skill of existing)
    await request.delete(`/api/v1/skills/${skill.id}`);
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "技能", exact: true }).click();
  await page
    .getByLabel("选择技能文件夹", { exact: true })
    .setInputFiles(resolve("docs/examples/text-notes"));
  await expect(page.getByRole("dialog")).toContainText("text-notes");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const skill = (await request.get("/api/v1/skills").then((r) => r.json()))[0];
  expect(skill.enabled).toBe(false);
  expect(skill.scripts_allowed).toBe(false);
  await page.getByRole("button", { name: "查看技能", exact: true }).click();
  await page.getByLabel("启用此技能", { exact: true }).check();
  await page
    .getByLabel("允许小汐自动运行此技能的脚本", { exact: true })
    .check();
  await page.screenshot({ path: `${shots}/skill-permission.png` });
  await page.keyboard.press("Escape");
  const runtime = await request.put("/api/v1/skill-runtimes", {
    data: { python: resolve("backend/.venv/Scripts/python.exe") },
  });
  expect(runtime.ok()).toBe(true);
  await page
    .getByRole("button", { name: "点击头像新建对话", exact: true })
    .click();
  await page
    .getByLabel("发送给XiaoXi的消息")
    .fill("本地013技能：用 text-notes 整理一份笔记");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.locator(".artifact-download button").filter({ hasText: "小笔记.md" }),
  ).toBeVisible({ timeout: 30000 });
  const downloaded = page.waitForEvent("download");
  await page
    .locator(".artifact-download button")
    .filter({ hasText: "小笔记.md" })
    .click();
  expect((await downloaded).suggestedFilename()).toBe("小笔记.md");
  await page.screenshot({ path: `${shots}/skill-output.png` });
  await page.getByRole("button", { name: "工具调用结果", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("运行技能脚本");
});

test("MCP image blocks and sources render and survive reloading the conversation", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/v1/mcp/servers", {
    data: {
      name: "013 本地验收 MCP",
      transport: "stdio",
      command: resolve("backend/.venv/Scripts/python.exe"),
      args: [resolve("backend/tests/mcp_fixture.py")],
      env: { MCP_FIXTURE_MEDIA: "1" },
      enabled: false,
    },
  });
  expect(created.ok()).toBe(true);
  const server = await created.json();
  expect(
    (await request.post(`/api/v1/mcp/servers/${server.id}/test`)).ok(),
  ).toBe(true);
  const catalog = await request.get("/api/v1/tools").then((r) => r.json());
  const tool = catalog.find(
    (x: any) => x.server_id === server.id && x.name === "media_fixture",
  );
  expect(tool).toBeTruthy();
  expect(
    (
      await request.patch(`/api/v1/tools/${tool.id}`, {
        data: { enabled: true },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await request.put(`/api/v1/mcp/servers/${server.id}`, {
        data: {
          name: server.name,
          transport: "stdio",
          command: server.command,
          args: server.args,
          env: {},
          enabled: true,
        },
      })
    ).ok(),
  ).toBe(true);
  await page
    .getByRole("button", { name: "点击头像新建对话", exact: true })
    .click();
  await page
    .getByLabel("发送给XiaoXi的消息")
    .fill("本地013图片来源：请运行模拟图片与来源验收");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".answer-presentation img")).toBeVisible({
    timeout: 30000,
  });
  await page.locator(".answer-sources > summary").click();
  await expect(
    page.getByRole("link", { name: /本地模拟网页来源/ }),
  ).toBeVisible();
  expect(
    await page
      .locator(".answer-presentation img")
      .evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBe(320);
  await page.screenshot({ path: `${shots}/mcp-image-sources.png` });
  await page.locator(".answer-presentation .picture-trigger").click();
  await expect(page.getByRole("dialog").locator("img")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await page
    .locator(".conversation-link > button:first-child")
    .filter({ hasText: "本地013图片来源" })
    .first()
    .click();
  await expect(page.locator(".answer-presentation img")).toBeVisible();
  await page.locator(".answer-sources > summary").click();
  await expect(
    page.getByRole("link", { name: /本地模拟网页来源/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "参考的记忆", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "这次回答查看了哪些记忆",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "这次没有找到合适的记忆",
  );
  await expect(page.getByText("查看查找细节", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/memory-explainer.png` });
  await page.keyboard.press("Escape");
  await request.delete(`/api/v1/mcp/servers/${server.id}`);
});

test("chat schedules plans directly and the two sidebars have distinct surfaces", async ({
  page,
  request,
}) => {
  const rail = await page
    .locator(".navigation-rail")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const sidebar = await page
    .locator(".chat-sidebar")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(rail).not.toBe(sidebar);
  await page
    .getByLabel("发送给XiaoXi的消息")
    .fill("本地013日序：帮我安排明天的读书计划并提醒我");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message.assistant")).toContainText(
    "日程工具已执行",
    { timeout: 30000 },
  );
  const events = await request
    .get("/api/v1/calendar/events")
    .then((r) => r.json());
  expect(events.filter((e: any) => e.title === "本地模拟：读书")).toHaveLength(
    1,
  );
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /本地模拟：读书/ }),
  ).toBeVisible();
});

test("compact month calendar fits the window without the removed title block", async ({
  page,
}) => {
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await expect(page.getByText("把日子慢慢安排好", { exact: true })).toHaveCount(
    0,
  );
  for (const size of [
    { width: 1280, height: 720 },
    { width: 720, height: 650 },
    { width: 1024, height: 600 },
  ]) {
    await page.setViewportSize(size);
    const dimensions = await page.locator(".calendar-page").evaluate((el) => ({
      height: el.clientHeight,
      scroll: el.scrollHeight,
      width: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.height + 1);
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
    const calendar = await page.locator(".calendar-page").boundingBox();
    const lastDay = await page.locator(".plan-day").last().boundingBox();
    expect(lastDay!.height).toBeGreaterThan(35);
    expect(lastDay!.y + lastDay!.height).toBeLessThanOrEqual(
      calendar!.y + calendar!.height + 1,
    );
    if (size.width === 720)
      await page.screenshot({ path: `${shots}/calendar-compact-narrow.png` });
  }
  await page.getByRole("button", { name: "下一期", exact: true }).click();
  await expect(page.locator(".plan-day")).toHaveCount(42);
  const sixWeek = await page.locator(".plan-day").last().boundingBox();
  expect(sixWeek!.y + sixWeek!.height).toBeLessThanOrEqual(600);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await page.screenshot({ path: `${shots}/calendar-compact.png` });
});
