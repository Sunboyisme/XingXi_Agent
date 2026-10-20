import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { selectCalendarDate } from "./helpers/calendarPicker";

test.skip(
  process.env.BAI_RECURRING_PLANS_QA !== "1",
  "Requires isolated recurrence QA",
);
const shots = resolve(".local-data/qa-recurring-plans/screenshots");
test.beforeEach(async ({ page, request }) => {
  const data = await request.get("/api/v1/settings/data").then((r) => r.json());
  expect(data.directory).toContain("qa-recurring-plans");
  mkdirSync(shots, { recursive: true });
  for (const plan of await request.get("/api/v1/plans").then((r) => r.json()))
    await request.delete(`/api/v1/plans/${plan.id}`);
  await page.goto("/");
  await page.getByRole("button", { name: "计划", exact: true }).click();
});

test("monthly repeats stay quiet while one-off items remain directly visible", async ({
  page,
  request,
}) => {
  for (const [title, hour] of [
    ["QA 喂猫早", "09"],
    ["QA 喂猫晚", "20"],
    ["QA 日常读书", "21"],
  ]) {
    expect(
      (
        await request.post("/api/v1/plans", {
          data: {
            title,
            start: `2026-10-20T${hour}:00:00+08:00`,
            end: `2026-10-20T${hour}:30:00+08:00`,
            recurrence: "daily",
            reminder_enabled: true,
          },
        })
      ).ok(),
    ).toBe(true);
  }
  await request.post("/api/v1/plans", {
    data: {
      title: "QA 单次会面",
      start: "2026-10-20T14:00:00+08:00",
      end: "2026-10-20T15:00:00+08:00",
    },
  });
  await request.post("/api/v1/plans", {
    data: {
      title: "QA 每周会议",
      start: "2026-10-20T11:00:00+08:00",
      end: "2026-10-20T12:00:00+08:00",
      recurrence: "weekly",
      calendar_display: "always",
    },
  });
  await page.reload();
  await page.getByRole("button", { name: "计划", exact: true }).click();
  const cell = page.locator(
    '.plan-day:has([aria-label="2026-10-20 添加计划"])',
  );
  await expect(cell.locator(".day-event")).toHaveCount(2);
  await expect(cell).toContainText("QA 单次会面");
  await expect(cell).toContainText("QA 每周会议");
  await expect(
    cell.getByRole("button", {
      name: "2026-10-20 每天重复 3 项",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/今日 4 项/)).toHaveCount(0);
  await page.screenshot({ path: resolve(shots, "monthly-summary.png") });
  await cell
    .getByRole("button", { name: "11:00 QA 每周会议", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").locator(".plan-agenda-row"),
  ).toHaveCount(4);
  await page
    .getByRole("button", { name: "完成本次 QA 喂猫早 2026-10-20", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "恢复本次 QA 喂猫早 2026-10-20",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "周历", exact: true }).click();
  expect(await page.locator(".week-event").count()).toBeGreaterThan(15);
  await expect(
    page.locator(".week-event").filter({ hasText: "QA 每周会议" }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(shots, "week-view.png") });
  await page.setViewportSize({ width: 720, height: 650 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("editor saves bounded repeats with the simplified recurring controls", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await page.getByRole("menuitem", { name: /重复日程/ }).click();
  await page.getByLabel("计划名称", { exact: true }).fill("QA 三次安排");
  await page.getByRole("combobox", { name: "重复频率", exact: true }).click();
  await page.getByRole("option", { name: "每天", exact: true }).click();
  await page.getByRole("combobox", { name: "重复结束", exact: true }).click();
  await page.getByRole("option", { name: "重复次数", exact: true }).click();
  await page.getByLabel("重复次数（含首次）", { exact: true }).fill("3");
  await page.getByLabel("指定时间", { exact: true }).check();
  await expect(page.getByLabel("月历显示", { exact: true })).toHaveCount(0);
  await selectCalendarDate(page, "开始", "2026-10-20", "09:00");
  await selectCalendarDate(page, "结束", "2026-10-20", "10:00");
  await page.screenshot({ path: resolve(shots, "recurrence-limits.png") });
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const plans = await request
    .get("/api/v1/plans?start=2026-10-20&end=2026-10-25")
    .then((r) => r.json());
  expect(plans).toHaveLength(3);
  expect(
    plans.every(
      (plan: any) =>
        plan.repeat_count === 3 && plan.calendar_display === "summary",
    ),
  ).toBe(true);
  const day23 = page.locator(
    '.plan-day:has([aria-label="2026-10-23 添加计划"])',
  );
  await expect(day23.locator(".day-event")).toHaveCount(0);
  await expect(page.getByText("今日 1 项")).toHaveCount(0);
});

test("editing a recurring plan updates the whole series and preserves completion history", async ({
  page,
  request,
}) => {
  const base = {
    title: "QA 整个系列",
    start: "2026-10-20T09:00:00+08:00",
    end: "2026-10-20T10:00:00+08:00",
    recurrence: "daily",
    repeat_count: 5,
    reminder_enabled: true,
  };
  const plan = await request
    .post("/api/v1/plans", { data: base })
    .then((r) => r.json());
  const expanded = await request
    .get("/api/v1/plans?start=2026-10-20&end=2026-10-25")
    .then((r) => r.json());
  await request.post(`/api/v1/plans/${plan.id}/action`, {
    data: {
      action: "complete",
      occurrence_start: expanded[0].occurrence_start,
    },
  });
  await page.reload();
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.getByRole("button", { name: "周历", exact: true }).click();
  await page
    .locator(".week-event")
    .filter({ hasText: "QA 整个系列" })
    .first()
    .click();
  await page
    .getByRole("button", { name: "编辑 QA 整个系列", exact: true })
    .click();
  await expect(page.getByLabel("修改范围", { exact: true })).toHaveCount(0);
  await page.getByLabel("计划名称", { exact: true }).fill("QA 整个系列已调整");
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const after = await request
    .get("/api/v1/plans?start=2026-10-20&end=2026-10-25")
    .then((r) => r.json());
  expect(after).toHaveLength(5);
  expect(after.every((event: any) => event.title === "QA 整个系列已调整")).toBe(
    true,
  );
  expect(after[0].status).toBe("completed");
  expect(after.every((event: any) => event.id === plan.id)).toBe(true);
  expect(
    (await request.get("/api/v1/plans").then((r) => r.json())).length,
  ).toBe(1);
  await page.getByRole("button", { name: "周历", exact: true }).click();
  await page
    .locator(".week-event")
    .filter({ hasText: "QA 整个系列已调整" })
    .first()
    .click();
  await page
    .getByRole("button", { name: "编辑 QA 整个系列已调整", exact: true })
    .click();
  await expect(page.getByLabel("修改范围", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("计划名称", { exact: true })).toHaveValue(
    "QA 整个系列已调整",
  );
});
