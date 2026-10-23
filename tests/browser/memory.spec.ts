import { test, expect, type Page } from "@playwright/test";

test.skip(
  process.env.BAI_MEMORY_QA !== "1",
  "需要独立记忆 QA 数据空间与模拟模型",
);
test.describe.configure({ mode: "default" });

async function send(page: Page, text: string) {
  await page.getByLabel("发送给XiaoXi的消息").fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".message.assistant").last()).toBeVisible();
}

test.beforeEach(async ({ page, request }) => {
  const previous = await request.get("/api/v1/settings").then((r) => r.json());
  for (const provider of previous.providers)
    await request.delete(`/api/v1/settings/providers/${provider.id}`);
  const response = await request.put("/api/v1/settings", {
    data: {
      model_url: process.env.BAI_MOCK_URL || "http://127.0.0.1:8889/v1",
      model_name: "mock-test",
      model_key: "synthetic-memory-013",
      memory_mode: "auto",
    },
  });
  expect(response.ok()).toBeTruthy();
  for (const type of ["memories", "conversations"]) {
    const values = await (await request.get(`/api/v1/${type}`)).json();
    for (const value of values)
      expect(
        (await request.delete(`/api/v1/${type}/${value.id}`)).ok(),
      ).toBeTruthy();
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  (page as any).memoryErrors = errors;
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "连接与设置", exact: true }),
  ).toBeVisible();
});
test.afterEach(async ({ page }) =>
  expect((page as any).memoryErrors).toEqual([]),
);

test("automatic preference saves without a dialog and Undo removes it", async ({
  page,
  request,
}) => {
  await send(page, "我喜欢简短的回答");
  await expect(page.locator(".memory-saved-notice")).toContainText("已记住");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("待确认记忆")).toHaveCount(0);
  await expect
    .poll(
      async () => (await (await request.get("/api/v1/memories")).json()).length,
    )
    .toBe(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".memory-saved-notice")).toHaveCount(0);
  expect(await (await request.get("/api/v1/memories")).json()).toEqual([]);
});

test("pending private information persists, is excluded from a new chat, then confirms", async ({
  page,
  request,
}) => {
  await send(page, "我有糖尿病");
  const review = page.getByLabel("待确认记忆");
  await expect(review).toContainText("包含私密信息");
  await review.getByText("查看来源", { exact: true }).click();
  await expect(review.locator("blockquote")).toHaveText("我有糖尿病");
  await page.screenshot({
    path: ".local-data/memory-qa-20261016/01-private-confirm.png",
    animations: "disabled",
  });
  await page.reload();
  await page.locator(".conversation-link > button:first-child").first().click();
  await expect(page.getByLabel("待确认记忆")).toBeVisible();
  await page
    .getByRole("button", { name: "点击头像新建对话", exact: true })
    .click();
  await send(page, "检查记忆背景：糖尿病");
  await expect(page.locator(".message.assistant").last()).toContainText(
    '"private_available": false',
  );
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await page
    .getByLabel("待确认记忆")
    .getByRole("button", { name: "记住", exact: true })
    .click();
  await expect(page.getByLabel("待确认记忆")).toHaveCount(0);
  expect((await (await request.get("/api/v1/memories")).json())[0].state).toBe(
    "confirmed",
  );
  await page
    .getByRole("button", { name: "点击头像新建对话", exact: true })
    .click();
  await send(page, "检查记忆背景：糖尿病");
  await expect(page.locator(".message.assistant").last()).toContainText(
    '"private_available": true',
  );
});

test("manual mode persists and Ignore discards a proposal; explicit requests still save", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await page.getByRole("combobox", { name: "记忆保存方式" }).click();
  await page.getByRole("option", { name: "每次确认", exact: true }).click();
  await expect(page.getByLabel("记忆保存方式")).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(page.getByLabel("记忆保存方式")).toContainText("每次确认");
  await page
    .getByRole("button", { name: "点击头像新建对话", exact: true })
    .click();
  await send(page, "我喜欢简短的回答");
  await expect(page.getByLabel("待确认记忆")).toContainText("每次确认");
  await page.getByRole("button", { name: "忽略", exact: true }).click();
  await expect(page.getByLabel("待确认记忆")).toHaveCount(0);
  expect(await (await request.get("/api/v1/memories")).json()).toEqual([]);
  await send(page, "请记住我喜欢先看例子");
  await expect(page.locator(".memory-saved-notice")).toContainText("已记住");
  await expect(page.getByLabel("待确认记忆")).toHaveCount(0);
  expect((await (await request.get("/api/v1/memories")).json())[0].state).toBe(
    "confirmed",
  );
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(page.getByLabel("记忆保存方式", { exact: true })).toContainText(
    "每次确认",
  );
});

test("temporary information remains in conversation without creating long-term memory", async ({
  page,
  request,
}) => {
  await send(page, "今天想吃清淡一点");
  await expect(page.getByLabel("待确认记忆")).toHaveCount(0);
  await expect(page.locator(".memory-saved-notice")).toHaveCount(0);
  expect(await (await request.get("/api/v1/memories")).json()).toEqual([]);
});

test("memory source, editing and deletion survive reload, including narrow layouts", async ({
  page,
  request,
}) => {
  await send(page, "我喜欢简短的回答");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  const card = page.locator(".memory-card");
  await card.getByText("查看来源", { exact: true }).click();
  await expect(card.locator("blockquote")).toHaveText("我喜欢简短的回答");
  await page.screenshot({
    path: ".local-data/memory-qa-20261016/02-memory-page.png",
    animations: "disabled",
  });
  for (const size of [
    { width: 700, height: 700 },
    { width: 360, height: 780 },
  ]) {
    await page.setViewportSize(size);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await expect(page.getByLabel("记忆保存方式")).toBeVisible();
    await page.screenshot({
      path: `.local-data/memory-qa-20261016/memory-${size.width}.png`,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await card.getByRole("button", { name: "编辑记忆", exact: true }).click();
  await page.getByLabel("想记住什么").fill("我喜欢先看实例再看理论");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(page.locator(".memory-card")).toContainText(
    "我喜欢先看实例再看理论",
  );
  await page.getByRole("button", { name: "删除记忆", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "删除记忆", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await (await request.get("/api/v1/memories")).json()).toEqual([]);
});
