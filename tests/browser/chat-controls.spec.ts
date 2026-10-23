import { test, expect } from "@playwright/test";

test.skip(process.env.BAI_CONTEXT_QA !== "1", "Requires isolated UI QA data");
test.describe.configure({ mode: "default" });

test("answer actions are compact, copyable and stay attached to historical runs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("发送给XiaoXi的消息").fill("界面测试：帮我计算");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "工具调用结果", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".tool-results,.chat-retrieval")).toHaveCount(0);
  const actions = page.getByRole("group", { name: "回答操作" }).first();
  for (const name of ["复制回答", "工具调用结果", "参考的记忆"]) {
    const box = await actions
      .getByRole("button", { name, exact: true })
      .boundingBox();
    expect(box?.height).toBeLessThanOrEqual(32);
    expect(box?.width).toBeLessThanOrEqual(32);
  }
  await actions.getByRole("button", { name: "复制回答" }).click();
  await expect(
    actions.getByRole("button", { name: "已复制回答" }),
  ).toBeVisible();
  await actions.getByRole("button", { name: "工具调用结果" }).click();
  await expect(page.getByRole("dialog")).toContainText("结果：244.80");
  await page.keyboard.press("Escape");
  await actions.getByRole("button", { name: "参考的记忆" }).click();
  await expect(page.getByRole("dialog")).toContainText("界面测试：帮我计算");
  await page.keyboard.press("Escape");
  await page.getByLabel("发送给XiaoXi的消息").fill("再说一句普通的话");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "回答操作" })
    .first()
    .getByRole("button", { name: "工具调用结果" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("结果：244.80");
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: ".local-data/context-review-20261017/compact-answer-actions.png",
  });
  await page.reload();
  await page
    .locator(".conversation-link > button:first-child")
    .filter({ hasText: "界面测试：帮我计算" })
    .first()
    .click();
  await page
    .getByRole("group", { name: "回答操作" })
    .first()
    .getByRole("button", { name: "工具调用结果" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("结果：244.80");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "点击头像新建对话" }).click();
  await expect(
    page.getByRole("heading", { name: "今天想做点什么？" }),
  ).toBeVisible();
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  await expect(page.getByLabel("发送给XiaoXi的消息")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("reminder spacing and custom calendar preserve Beijing time", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const suffix = String(Date.now());
  const titles = [`整理项目资料 ${suffix}`, `归档练习笔记 ${suffix}`];
  for (const [index, title] of titles.entries()) {
    const response = await request.post("/api/v1/reminders", {
      data: {
        title,
        body: "整理完成后核对清单，保留必要的说明与执行记录。",
        due_at: `2026-11-${index ? "16" : "14"}T01:00:00Z`,
        timezone: "Asia/Shanghai",
        recurrence: "none",
      },
    });
    expect(response.ok()).toBe(true);
  }
  await page.goto("/");
  await page.getByRole("button", { name: "提醒", exact: true }).click();
  const first = page.locator(".reminder-row").filter({ hasText: titles[0] });
  const second = page.locator(".reminder-row").filter({ hasText: titles[1] });
  await expect(first).toBeVisible();
  await expect(page.getByRole("button", { name: "稍后 10 分钟" })).toHaveCount(
    0,
  );
  const one = await first.boundingBox();
  const two = await second.boundingBox();
  expect(two!.y - one!.y - one!.height).toBeGreaterThanOrEqual(12);
  await page.screenshot({
    path: ".local-data/context-review-20261017/reminder-spacing.png",
  });
  await first
    .getByRole("button", { name: `编辑 ${titles[0]}`, exact: true })
    .click();
  await page.getByRole("button", { name: "时间（北京时间）" }).click();
  await expect(page.locator('input[type="datetime-local"]')).toHaveCount(0);
  await expect(page.getByText("2026年11月", { exact: true })).toBeVisible();
  await page.screenshot({
    path: ".local-data/context-review-20261017/calendar-desktop.png",
  });
  await page.getByRole("button", { name: "2026年11月21日 星期六" }).click();
  await page.getByLabel("小时", { exact: true }).fill("10");
  await page.getByLabel("分钟", { exact: true }).fill("45");
  await page.getByRole("button", { name: "确定", exact: true }).click();
  const saved = page.waitForRequest(
    (request) =>
      request.method() === "PUT" && /\/reminders\/[^/]+$/.test(request.url()),
  );
  await page.getByRole("button", { name: "保存提醒", exact: true }).click();
  expect((await saved).postDataJSON().due_at).toBe("2026-11-21T02:45:00.000Z");
  await expect(first).toContainText("10:45");
  await first
    .getByRole("button", { name: `编辑 ${titles[0]}`, exact: true })
    .click();
  await page.getByRole("button", { name: "时间（北京时间）" }).click();
  await expect(
    page.getByRole("button", { name: "2026年11月21日 星期六" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 720, height: 800 });
  await expect
    .poll(
      async () => (await page.locator(".datetime-popover").boundingBox())?.y,
    )
    .toBeGreaterThanOrEqual(0);
  const panel = await page.locator(".datetime-popover").boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(720);
  expect(panel!.y).toBeGreaterThanOrEqual(0);
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(800);
  await page.screenshot({
    path: ".local-data/context-review-20261017/calendar-narrow.png",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "编辑提醒" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "点击头像新建对话" }).click();
  await expect(
    page.getByRole("heading", { name: "今天想做点什么？" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
