import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

test.skip(
  process.env.BAI_FEEDBACK_018 !== "1",
  "Requires isolated feedback018 services",
);
const output = resolve(".local-data/bug-review-018/screenshots");
test.beforeAll(() => mkdirSync(output, { recursive: true }));
test.beforeEach(async ({ page, request }) => {
  const data = await request
    .get("/api/v1/settings/data")
    .then((response) => response.json());
  expect(data.directory).toContain("bug-review-018");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  (page as any).reviewErrors = errors;
  await page.goto("/");
  await page.getByRole("button", { name: "学习", exact: true }).waitFor();
});
test.afterEach(async ({ page }) =>
  expect((page as any).reviewErrors).toEqual([]),
);

test("learning directions are independent and home navigation remains explicit", async ({
  page,
}) => {
  await page.getByRole("button", { name: "学习", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "一起确定你的学习方向" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "创建学习", exact: true }).click();
  const answer = page.getByRole("textbox", { name: "学习目标对话" });
  await answer.fill("我想学HTML，能够理解页面结构");
  await page.getByRole("button", { name: "发送回答", exact: true }).click();
  await expect(
    page.getByText("你目前有什么基础？", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回学习", exact: true }).click();
  await expect(page.getByText("访谈草稿 · 已自动保存").first()).toBeVisible();
  await page.getByRole("button", { name: "创建学习", exact: true }).click();
  await expect(answer).toHaveValue("");
  await expect(
    page.getByText("我想学HTML，能够理解页面结构", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "学习", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "创建学习", exact: true }),
  ).toBeVisible();
});

test("todo CRUD works without calendar events and editor preserves keyboard access", async ({
  page,
  request,
}) => {
  const saved = await request
    .get("/api/v1/todos?status=all")
    .then((r) => r.json());
  for (const row of saved.filter((row: any) => row.title === "交互检查待办"))
    await request.delete(`/api/v1/todos/${row.id}`);
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.getByRole("button", { name: "待办", exact: true }).click();
  await page.getByRole("button", { name: "新增待办", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("待办名称").fill("交互检查待办");
  await dialog.getByRole("textbox", { name: "备注", exact: true }).fill("保留这段备注");
  await dialog.getByRole("button", { name: "保存待办", exact: true }).click();
  const row = page.locator(".todo-row").filter({ hasText: "交互检查待办" });
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: "编辑交互检查待办", exact: true })
    .click();
  await expect(dialog.getByRole("textbox", { name: "备注", exact: true })).toHaveValue(
    "保留这段备注",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await row
    .getByRole("button", { name: "完成交互检查待办", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await row
    .getByRole("button", { name: "恢复交互检查待办", exact: true })
    .click();
  await page.getByRole("button", { name: "未完成", exact: true }).click();
  await row
    .getByRole("button", { name: "删除交互检查待办", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "删除待办", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  const plans = await request
    .get("/api/v1/plans?start=2026-10-01&end=2026-11-01&timezone=Asia/Shanghai")
    .then((r) => r.json());
  expect(plans.some((value: any) => value.title === "交互检查待办")).toBe(
    false,
  );
});

test("knowledge folder import, retrieval and source navigation close their dialog", async ({
  page,
  request,
}) => {
  const saved = await request
    .get("/api/v1/knowledge/documents")
    .then((r) => r.json());
  for (const doc of saved.filter((doc: any) =>
    doc.relative_path.startsWith("护理档案/"),
  ))
    await request.delete(`/api/v1/knowledge/documents/${doc.id}`);
  const folder = resolve(".local-data/bug-review-018/fixtures/护理档案");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    resolve(folder, "雪豹.md"),
    "# 雪豹护理\n\n雪豹的护理档案记录在高山观察站。\n",
  );
  writeFileSync(
    resolve(folder, "说明.txt"),
    "观察站的记录包括雪豹护理和健康状况。",
  );
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await page.locator("input[webkitdirectory]").setInputFiles(folder);
  await page.getByRole("button", { name: /雪豹.md/ }).click();
  await expect(
    page.getByRole("heading", { name: "雪豹护理", exact: true }),
  ).toBeVisible();
  const toggle = page.getByRole("switch", { name: "启用知识库检索" });
  if (!(await toggle.isChecked())) await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(
    page
      .locator(".knowledge-tree")
      .getByText("可检索", { exact: true })
      .first(),
  ).toBeVisible({ timeout: 15000 });
  await page
    .getByRole("textbox", { name: "搜索知识库", exact: true })
    .fill("雪豹护理");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("button", { name: /知识库来源/ }).click();
  await page
    .getByRole("dialog")
    .locator(".knowledge-source")
    .filter({ hasText: "雪豹.md" })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".knowledge-related")).toContainText("雪豹");
});

test("all new pages fit minimum and regular windows in both themes", async ({
  page,
}) => {
  for (const theme of ["warm-dark", "cream"]) {
    await page.evaluate(
      (theme) => localStorage.setItem("xiaoxi-appearance-theme", theme),
      theme,
    );
    await page.reload();
    for (const [width, height] of [
      [700, 440],
      [1280, 720],
    ]) {
      await page.setViewportSize({ width, height });
      for (const name of ["学习", "计划", "知识库", "连接与设置"]) {
        await page.getByRole("button", { name, exact: true }).click();
        if (name === "计划")
          await page.getByRole("button", { name: "待办", exact: true }).click();
        const target =
          name === "学习"
            ? ".learning-home-heading"
            : name === "计划"
              ? ".todo-page"
              : name === "知识库"
                ? ".knowledge-page"
                : ".general-settings";
        await expect(page.locator(target)).toBeVisible();
        const geometry = await page.locator(target).evaluate((element) => ({
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          right: element.getBoundingClientRect().right,
          width: innerWidth,
        }));
        expect(geometry.overflow).toBe(false);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
        await page.screenshot({
          path: resolve(output, `${theme}-${name}-${width}.png`),
        });
      }
    }
  }
});
