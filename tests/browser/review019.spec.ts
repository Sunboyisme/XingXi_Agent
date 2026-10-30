import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "连接与设置", exact: true }),
  ).toBeVisible({ timeout: 30000 });
});

test("startup has no cancel action and all navigation and settings pages remain usable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("button", { name: "取消连接" })).toHaveCount(0);
  for (const name of ["项目", "学习", "计划", "知识库", "常用文本", "对话"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".main-panel")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "连接与设置", exact: true }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  for (const name of [
    "常规",
    "外观",
    "桌面助手",
    "模型连接",
    "能力连接",
    "工具",
    "技能",
    "脚本环境",
    "微信",
    "记忆",
    "用量与费用",
    "数据管理",
  ]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect(
      page.getByRole("tabpanel", { name, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
  expect(errors).toEqual([]);
  await page.screenshot({
    path: ".local-data/full-review-20261030/settings.png",
  });
});

test("text cards clamp at four lines, align actions, open full text and retain default classification", async ({
  page,
  request,
}) => {
  const content = "界面回归：" + "春天到了，花开了。".repeat(40);
  const long = await request
    .post("/api/v1/common-texts", { data: { content, category_id: null } })
    .then((r) => r.json());
  const short = await request
    .post("/api/v1/common-texts", {
      data: { content: "界面回归短文本", category_id: null },
    })
    .then((r) => r.json());
  try {
    await page.getByRole("button", { name: "常用文本", exact: true }).click();
    await page.getByLabel("搜索正文或分类").fill("界面回归");
    await expect(page.locator(".common-text-card")).toHaveCount(2);
    const card = page
      .locator(".common-text-card")
      .filter({ hasText: "界面回归：" });
    await expect(card.getByRole("button", { name: "查看全文" })).toBeVisible();
    const clamp = await card
      .locator(".common-text-body")
      .evaluate((element) => ({
        clamp: getComputedStyle(element).webkitLineClamp,
        scroll: element.scrollHeight,
        height: element.clientHeight,
      }));
    expect(clamp.clamp).toBe("4");
    expect(clamp.scroll).toBeGreaterThan(clamp.height);
    const actions = await page
      .locator(".common-text-card-actions")
      .evaluateAll((elements) =>
        elements.map((node) => node.getBoundingClientRect().bottom),
      );
    expect(Math.abs(actions[0] - actions[1])).toBeLessThan(2);
    await card.getByRole("button", { name: "查看全文" }).click();
    await expect(
      page.getByRole("dialog").locator(".common-text-full"),
    ).toHaveText(content);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByLabel("搜索正文或分类").fill("默认分类");
    await expect(
      page.locator(".common-text-card").filter({ hasText: "界面回归短文本" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 750, height: 720 });
    expect(
      await page
        .locator(".common-texts-page")
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: ".local-data/full-review-20261030/common-texts-narrow.png",
    });
  } finally {
    await request.delete(`/api/v1/common-texts/${long.id}`);
    await request.delete(`/api/v1/common-texts/${short.id}`);
  }
});

test("an empty category offers creation in that category; only searches offer clearing filters", async ({
  page,
  request,
}) => {
  const name = `空分类-${Date.now()}`;
  const category = await request
    .post("/api/v1/common-text-categories", { data: { name } })
    .then((r) => r.json());
  let textId = "";
  try {
    await page.getByRole("button", { name: "常用文本", exact: true }).click();
    await page.getByRole("combobox", { name: "筛选分类" }).click();
    await page.getByRole("option", { name, exact: true }).click();
    await expect(
      page.getByRole("button", { name: "新增文本", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "清除筛选" })).toHaveCount(0);
    await page.getByRole("button", { name: "新增文本", exact: true }).click();
    const editor = page.getByRole("dialog");
    await expect(editor.getByRole("combobox", { name: "文本分类" })).toHaveText(
      name,
    );
    await editor.getByLabel("正文", { exact: true }).fill("分类空态创建检查");
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".common-text-card")).toHaveCount(1);
    textId = await request
      .get(`/api/v1/common-texts?category_id=${category.id}`)
      .then((r) => r.json())
      .then((rows) => rows[0].id);
    await page.getByLabel("搜索正文或分类").fill("不会匹配的关键词");
    await expect(
      page.getByRole("heading", { name: "没有找到匹配文本" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "清除筛选" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "新增文本", exact: true }),
    ).toHaveCount(0);
  } finally {
    if (textId) await request.delete(`/api/v1/common-texts/${textId}`);
    await request.delete(`/api/v1/common-text-categories/${category.id}`);
  }
});

test("navigation can be dragged and keyboard reordered without a handle and survives reload", async ({
  page,
}) => {
  await page.locator(".navigation-more").click();
  const common = page.locator(
    '.navigation-overflow-row[data-feature="common-texts"]',
  );
  const projects = page.locator(
    '.navigation-overflow-row[data-feature="projects"]',
  );
  const start = await common.locator(".navigation-overflow-link").boundingBox();
  const end = await projects.locator(".navigation-overflow-link").boundingBox();
  const savedBefore = await page.evaluate(() =>
    localStorage.getItem("xiaoxi-general-preferences-v1"),
  );
  await page.mouse.move(start!.x + 35, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(end!.x + 35, end!.y + end!.height / 2, { steps: 12 });
  await expect(
    page.locator(".navigation-overflow-row").first(),
  ).toHaveAttribute("data-feature", "common-texts");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("xiaoxi-general-preferences-v1"),
    ),
  ).toBe(savedBefore);
  await page.mouse.up();
  await expect(page.locator(".navigation-overflow-menu")).toBeVisible();
  await expect(
    page.locator('.main-navigation > button[aria-label="对话"]'),
  ).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(
    page.locator(".main-navigation > button").nth(1),
  ).toHaveAttribute("aria-label", "常用文本");
  await page.locator(".navigation-more").click();
  const item = page.locator(
    '.navigation-overflow-row[data-feature="common-texts"] .navigation-overflow-link',
  );
  await item.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator(".navigation-overflow-row").nth(1)).toHaveAttribute(
    "data-feature",
    "common-texts",
  );
  await expect(
    page.locator('.navigation-overflow-row [aria-label*="拖动"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('.navigation-overflow-row[draggable="true"]'),
  ).toHaveCount(0);
});

test("sidebar pointer sorting saves order without navigating, and Escape cancels a menu drag", async ({
  page,
}) => {
  const nav = page.getByRole("navigation", { name: "主导航" });
  const start = await nav
    .locator('[data-navigation-feature="common-texts"]')
    .boundingBox();
  const end = await nav
    .locator('[data-navigation-feature="projects"]')
    .boundingBox();
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, {
    steps: 12,
  });
  await expect(
    nav.locator("[data-navigation-feature]").first(),
  ).toHaveAttribute("data-navigation-feature", "common-texts");
  await page.mouse.up();
  await expect(
    nav.getByRole("button", { name: "对话", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.locator(".navigation-more").click();
  const savedBefore = await page.evaluate(() =>
    localStorage.getItem("xiaoxi-general-preferences-v1"),
  );
  const origin = await page
    .locator('[data-feature="common-texts"] .navigation-overflow-link')
    .boundingBox();
  const target = await page
    .locator('[data-feature="knowledge"] .navigation-overflow-link')
    .boundingBox();
  await page.mouse.move(origin!.x + 30, origin!.y + origin!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + 30, target!.y + target!.height / 2, {
    steps: 12,
  });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("xiaoxi-general-preferences-v1"),
    ),
  ).toBe(savedBefore);
  await expect(page.locator('[data-reorder-dragging="true"]')).toHaveCount(0);
  await expect(
    page.locator(".navigation-overflow-row").first(),
  ).toHaveAttribute("data-feature", "common-texts");
  const toggle = page.getByRole("menuitemcheckbox", { name: "在侧栏显示学习" });
  await toggle.click();
  await expect(
    nav.getByRole("button", { name: "学习", exact: true }),
  ).toHaveCount(0);
});

test("knowledge import, reading, directory collapse and search share the available width", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "从第一份资料开始" }),
  ).toBeVisible();
  const prefix = `review-${Date.now()}`;
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: `${prefix}.md`,
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "# 资料检查\n\n春天的植物开始生长。回归检索词：花开。\n",
      ),
    });
  let id = "";
  try {
    await expect
      .poll(
        async () => {
          const docs = await request
            .get("/api/v1/knowledge/documents")
            .then((r) => r.json());
          const doc = docs.find(
            (row: { relative_path: string }) =>
              row.relative_path === `${prefix}.md`,
          );
          id = doc?.id || "";
          return doc?.status;
        },
        { timeout: 20000 },
      )
      .toBe("ready");
    await expect(
      page
        .locator(".knowledge-preview")
        .getByRole("heading", { name: "资料检查", exact: true }),
    ).toBeVisible({ timeout: 10000 });
    const before = await page.locator(".knowledge-preview").boundingBox();
    await page
      .getByRole("button", { name: "收起资料目录", exact: true })
      .click();
    await expect(page.locator("#knowledge-directory")).toBeHidden();
    const after = await page.locator(".knowledge-preview").boundingBox();
    expect(after!.width).toBeGreaterThan(before!.width + 180);
    await page
      .getByRole("button", { name: "展开资料目录", exact: true })
      .click();
    const enabled = page.getByRole("switch", { name: "启用知识库检索" });
    if (!(await enabled.isChecked())) await enabled.check();
    await page.getByLabel("搜索知识库", { exact: true }).fill("花开");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".knowledge-search-result")).toHaveCount(1);
    await page.setViewportSize({ width: 750, height: 720 });
    expect(
      await page
        .locator(".knowledge-workspace")
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: ".local-data/full-review-20261030/knowledge-narrow.png",
    });
  } finally {
    if (id) await request.delete(`/api/v1/knowledge/documents/${id}`);
  }
});
