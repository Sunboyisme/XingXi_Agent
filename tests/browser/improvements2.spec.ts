import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

test.skip(
  process.env.BAI_IMPROVEMENTS2_QA !== "1",
  "Requires the isolated 0.1.3 improvements QA runtime",
);

const shots = resolve(".local-data/qa-013-improvements2/screenshots");

test.beforeEach(async ({ request }) => {
  const data = await request.get("/api/v1/settings/data").then((r) => r.json());
  expect(data.directory).toContain("qa-013-improvements2-runtime");
  mkdirSync(shots, { recursive: true });
});

test("new chat focuses the composer and keeps text and images across navigation", async ({
  page,
  request,
}) => {
  const settings = await request.get("/api/v1/settings").then((r) => r.json());
  expect(
    (
      await request.put("/api/v1/settings", {
        data: {
          ...settings,
          providers: [
            {
              id: "custom",
              provider_type: "custom",
              label: "QA 本地连接",
              model_url: "http://127.0.0.1:8791/v1",
              default_model: "qa-model",
              models: [
                {
                  name: "qa-model",
                  vision_enabled: true,
                  thinking_mode: "auto",
                },
              ],
              api_key: "qa-placeholder-key",
            },
          ],
          default_provider: "custom",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "开启新对话" }).click();
  const input = page.getByLabel("发送给XiaoXi的消息");
  await expect(input).toBeFocused();
  await input.fill("离开对话前还没发送的内容");
  await page
    .getByLabel("添加图片")
    .setInputFiles(resolve("docs/updata/0.1.3/0.1.3改进2/9.png"));
  await expect(page.getByText("9.png", { exact: true })).toBeVisible();
  await expect(page.locator(".attachment-uploading")).toHaveCount(0);

  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(input).toHaveValue("离开对话前还没发送的内容");
  await expect(page.getByText("9.png", { exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await page.screenshot({ path: resolve(shots, "chat-draft-restore.png") });

  await page.getByRole("button", { name: "开启新对话" }).click();
  await expect(input).toHaveValue("");
  await expect(page.locator(".attachment-draft")).toHaveCount(0);
  await expect(input).toBeFocused();
});

test("calendar categories, day agenda and editor follow the requested interaction", async ({
  page,
  request,
}) => {
  for (const plan of await request.get("/api/v1/plans").then((r) => r.json()))
    await request.delete(`/api/v1/plans/${plan.id}`);
  for (const [title, hour, recurrence] of [
    ["QA 待办事项", "14", "none"],
    ["QA 每日重复", "09", "daily"],
    ["QA 每周重复", "20", "weekly"],
  ] as const) {
    expect(
      (
        await request.post("/api/v1/plans", {
          data: {
            title,
            start: `2026-10-19T${hour}:00:00+08:00`,
            end: `2026-10-19T${hour}:30:00+08:00`,
            recurrence,
            ...(title === "QA 待办事项" ? { status: "ended" } : {}),
          },
        })
      ).ok(),
    ).toBe(true);
  }

  await page.goto("/");
  await page.getByRole("button", { name: "计划", exact: true }).click();
  const calendarBox = await page.locator(".plan-calendar").boundingBox();
  const periodBox = await page.locator(".calendar-period").boundingBox();
  expect(
    Math.abs(
      periodBox!.x +
        periodBox!.width / 2 -
        (calendarBox!.x + calendarBox!.width / 2),
    ),
  ).toBeLessThan(3);
  const day = page.locator('.plan-day:has([aria-label="2026-10-19 添加计划"])');
  const weekly = day.getByRole("button", {
    name: "20:00 QA 每周重复",
    exact: true,
  });
  await expect(weekly).toBeVisible();
  const dailyRepeat = day.getByRole("button", {
    name: "2026-10-19 每天重复 1 项",
    exact: true,
  });
  await expect(dailyRepeat).toBeVisible();
  await expect(page.getByText(/今日 2 项/)).toHaveCount(0);
  await page.screenshot({ path: resolve(shots, "calendar-month.png") });

  await dailyRepeat.click();
  await expect(
    page.getByRole("dialog").getByRole("tab", { name: /重复 2 项/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");

  await day
    .getByRole("button", { name: "14:00 QA 待办事项", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: /待办事项/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.locator(".plan-agenda-row")).toHaveCount(1);
  const completeEnded = dialog.getByRole("button", {
    name: "完成 QA 待办事项 2026-10-19",
    exact: true,
  });
  await expect(completeEnded).toBeEnabled();
  await completeEnded.click();
  await expect(dialog.getByRole("status")).toContainText(
    "已完成「QA 待办事项」",
  );
  await dialog
    .getByRole("button", { name: "编辑 QA 待办事项", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("指定时间", { exact: true }),
  ).not.toBeChecked();
  await page.keyboard.press("Escape");

  await weekly.click();
  await expect(dialog.getByRole("tab", { name: /重复 2 项/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.locator(".plan-agenda-row")).toHaveCount(2);
  await expect(dialog.getByText("查看、编辑或完成当天事项。")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "编辑 QA 每日重复" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "完成本次 QA 每日重复 2026-10-19" })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已完成");
  await dialog.getByRole("tab", { name: /待办事项/ }).click();
  await expect(dialog.locator(".plan-agenda-row")).toHaveCount(1);
  await page.screenshot({ path: resolve(shots, "calendar-day-agenda.png") });

  await dialog.getByRole("button", { name: "添加计划", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(
    editor.getByRole("heading", { name: "安排一件小事" }),
  ).toBeVisible();
  await expect(editor.getByLabel("修改范围")).toHaveCount(0);
  await expect(editor.getByLabel("月历显示")).toHaveCount(0);
  await expect(editor.getByRole("combobox", { name: "重复频率" })).toHaveCount(
    0,
  );
  await page.screenshot({ path: resolve(shots, "calendar-editor-single.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await expect(page.locator(".plan-add-menu")).toBeVisible();
  await page.screenshot({ path: resolve(shots, "calendar-add-menu.png") });
  await page.getByRole("menuitem", { name: /重复日程/ }).click();
  const repeatEditor = page.getByRole("dialog");
  await expect(
    repeatEditor.getByRole("heading", { name: "安排重复日程" }),
  ).toBeVisible();
  await expect(
    repeatEditor.getByRole("combobox", { name: "重复频率", exact: true }),
  ).toContainText("每天");
  await repeatEditor
    .getByRole("combobox", { name: "重复频率", exact: true })
    .click();
  await page.getByRole("option", { name: "每周", exact: true }).click();
  await expect(
    repeatEditor.getByRole("combobox", {
      name: "重复频率",
      exact: true,
    }),
  ).toContainText("每周");
  await repeatEditor
    .getByRole("combobox", { name: "重复频率", exact: true })
    .click();
  await page.getByRole("option", { name: "每天", exact: true }).click();
  await expect(
    repeatEditor.getByRole("combobox", {
      name: "重复频率",
      exact: true,
    }),
  ).toContainText("每天");
  await page.screenshot({ path: resolve(shots, "calendar-editor-repeat.png") });

  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "列表", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "周历", exact: true }).click();
  await expect(page.locator(".plan-week-grid")).toBeVisible();
  await expect(page.locator(".plan-week-allday")).toHaveCount(0);
  await expect(
    page.locator(".week-event").filter({ hasText: "QA 每日重复" }).first(),
  ).toBeVisible();
  await page.screenshot({ path: resolve(shots, "calendar-week.png") });
});

test("assistant replies keep the interactive XiaoXi avatar and thought bubble", async ({
  page,
}) => {
  await page.route("**/api/v1/conversations", (route) =>
    route.fulfill({
      json: [
        {
          id: "qa-chat",
          title: "QA 头像交互",
          created_at: "2026-10-19T10:00:00+08:00",
          updated_at: "2026-10-19T10:01:00+08:00",
        },
      ],
    }),
  );
  await page.route("**/api/v1/conversations/qa-chat/messages", (route) =>
    route.fulfill({
      json: [
        {
          id: "qa-user",
          role: "user",
          content: "今天下午提醒我浇花。",
          attachment_ids: [],
          reasoning: "",
          run_id: null,
          created_at: "2026-10-19T10:00:00+08:00",
          updated_at: "2026-10-19T10:00:00+08:00",
        },
        {
          id: "qa-assistant",
          role: "assistant",
          content: "好呀，我会在下午提醒你。",
          attachment_ids: [],
          reasoning: "先确认今天下午是否已有其他安排，再把提醒放到合适的时间。",
          run_id: "qa-run",
          created_at: "2026-10-19T10:01:00+08:00",
          updated_at: "2026-10-19T10:01:00+08:00",
        },
      ],
    }),
  );
  await page.route("**/api/v1/runs?conversation_id=qa-chat", (route) =>
    route.fulfill({ json: [] }),
  );

  await page.goto("/");
  await page
    .locator(".conversation-link > button:first-child")
    .filter({ hasText: "QA 头像交互" })
    .click();
  const avatar = page.getByRole("button", {
    name: "和XiaoXi打个招呼，继续聊天",
  });
  await expect(avatar).toBeVisible();
  await expect(
    page.getByRole("button", { name: "看看 XiaoXi 的小想法" }),
  ).toBeVisible();
  await avatar.click();
  await expect(page.getByRole("status")).toContainText("我在呢");
  await expect(page.getByLabel("发送给XiaoXi的消息")).toBeFocused();
  await page.screenshot({ path: resolve(shots, "chat-avatar.png") });
});

test("the home agenda opens the selected plan directly", async ({
  page,
  request,
}) => {
  for (const plan of await request.get("/api/v1/plans").then((r) => r.json()))
    await request.delete(`/api/v1/plans/${plan.id}`);
  expect(
    (
      await request.post("/api/v1/plans", {
        data: {
          title: "QA 首页直达计划",
          start: "2026-10-19T16:00:00+08:00",
          end: "2026-10-19T16:30:00+08:00",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "打开计划 QA 首页直达计划" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("计划名称")).toHaveValue("QA 首页直达计划");
  await page.screenshot({ path: resolve(shots, "home-plan-direct.png") });
});

test("memory settings keeps its title, controls and cards aligned", async ({
  page,
  request,
}) => {
  const created: string[] = [];
  for (const content of [
    "QA 记忆排版：喜欢先了解整体结构，再逐步练习。",
    "QA 记忆排版：每周整理一次项目记录，保留关键决定和下一步。",
  ]) {
    const response = await request.post("/api/v1/memories", {
      data: {
        content,
        category: "preference",
        source: "QA 排版检查",
        state: "confirmed",
      },
    });
    expect(response.ok()).toBe(true);
    created.push((await response.json()).id);
  }

  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(page.locator(".memory-page-heading")).toBeVisible();
  await expect(page.locator(".memory-toolbar")).toBeVisible();
  await expect(
    page.locator(".memory-card").filter({ hasText: "QA 记忆排版" }),
  ).toHaveCount(2);
  await page.screenshot({ path: resolve(shots, "memory-settings.png") });

  await page.setViewportSize({ width: 720, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: resolve(shots, "memory-settings-narrow.png") });

  for (const id of created) await request.delete(`/api/v1/memories/${id}`);
});

test("memory lookup explains the result in plain language", async ({
  page,
}) => {
  await page.route("**/api/v1/memories/retrieval/preview", (route) =>
    route.fulfill({
      json: {
        query: "你好",
        purpose: "preview",
        mode: "keyword",
        fallback_reason: "语义检索未启用",
        indexed: 0,
        total: 2,
        threshold: 0.35,
        token_budget: 1500,
        tokens_used: 0,
        duration_ms: 0,
        selected_ids: [],
        candidates: [],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await page.getByRole("button", { name: "试着查找记忆" }).click();
  await page.getByLabel("检索测试问题").fill("你好");
  await page.getByRole("button", { name: "查找", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("这次没有找到合适的记忆");
  await expect(dialog).toContainText("当前使用文字匹配");
  await expect(dialog).toContainText("用于查找的原话");
  await page.screenshot({ path: resolve(shots, "memory-lookup.png") });
});
