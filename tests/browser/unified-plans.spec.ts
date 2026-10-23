import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { selectCalendarDate } from "./helpers/calendarPicker";

test.skip(
  process.env.BAI_UNIFIED_PLANS_QA !== "1",
  "Requires isolated unified-plan data",
);
const shots = resolve(".local-data/qa-unified-plans/screenshots");
test.beforeAll(async ({ request }) => {
  mkdirSync(shots, { recursive: true });
  const status = await request
    .get("/api/v1/settings/data")
    .then((r) => r.json());
  expect(JSON.stringify(status)).toMatch(/qa-(?:(?:unified|recurring)-plans|017a)/);
  for (const item of await request.get("/api/v1/plans").then((r) => r.json()))
    await request.delete(`/api/v1/plans/${item.id}`);
});
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  (page as any).testErrors = errors;
  await page.goto("/");
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "提醒", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "日历计划", exact: true }),
  ).toHaveCount(0);
});
test.afterEach(async ({ page }) => {
  expect((page as any).testErrors).toEqual([]);
});

test("one recurring item has two views, multiple reminders and whole-series editing", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await page.getByRole("menuitem", { name: /重复日程/ }).click();
  await page.getByLabel("计划名称", { exact: true }).fill("QA 统一重复事项");
  await page.getByRole("combobox", { name: "重复频率", exact: true }).click();
  await page.getByRole("option", { name: "每天", exact: true }).click();
  await page.getByLabel("指定时间", { exact: true }).check();
  await selectCalendarDate(page, "开始", "2026-10-20", "09:00");
  await selectCalendarDate(page, "结束", "2026-10-20", "10:00");
  await page.getByLabel("设置提醒时间", { exact: true }).check();
  await selectCalendarDate(page, "提醒时间", "2026-10-20", "08:30");
  await page.getByRole("button", { name: "添加提醒时间", exact: true }).click();
  await selectCalendarDate(page, "提醒时间 2", "2026-10-20", "09:00");
  await page.screenshot({ path: resolve(shots, "multiple-reminders.png") });
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const series = (
    await request.get("/api/v1/plans").then((r) => r.json())
  ).find((p: any) => p.title === "QA 统一重复事项");
  expect(series.reminder_offsets).toEqual([-30, 0]);
  expect(
    (await request.get("/api/v1/plans").then((r) => r.json())).filter(
      (p: any) => p.title === series.title,
    ),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "周历", exact: true }).click();
  const repeatDays = page.locator(".plan-week-repeats > div");
  const day20Event = repeatDays
    .nth(1)
    .getByRole("button", { name: /重复事项 1 项/ })
    .first();
  const day21Event = repeatDays
    .nth(2)
    .getByRole("button", { name: /重复事项 1 项/ })
    .first();
  await day20Event.click();
  await page
    .getByRole("button", {
      name: `完成本次 ${series.title} 2026-10-20`,
      exact: true,
    })
    .click();
  await page.keyboard.press("Escape");
  await day20Event.click();
  await expect(page.getByRole("dialog").locator(".day-event")).toHaveClass(
    /is-completed/,
  );
  await page.keyboard.press("Escape");
  await day21Event.click();
  await expect(page.getByRole("dialog").locator(".day-event")).not.toHaveClass(
    /is-completed/,
  );
  await page.keyboard.press("Escape");
  await page.screenshot({ path: resolve(shots, "calendar-completed.png") });
  await day21Event.click();
  await page
    .getByRole("button", { name: `编辑 ${series.title}`, exact: true })
    .click();
  await expect(page.getByLabel("修改范围", { exact: true })).toHaveCount(0);
  await page.getByLabel("设置提醒时间", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const saved = await request
    .get(`/api/v1/plans/${series.id}`)
    .then((r) => r.json());
  expect(saved.status).toBe("planned");
  expect(saved.reminder_enabled).toBe(false);
  await day21Event.click();
  await page
    .getByRole("button", { name: `编辑 ${series.title}`, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "完成本次", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "结束整个系列", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "结束系列", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const after = await request
    .get(`/api/v1/plans/${series.id}`)
    .then((r) => r.json());
  expect(after.status).toBe("ended");
  const future = await request
    .get("/api/v1/plans?start=2026-10-22&end=2026-10-23")
    .then((r) => r.json());
  expect(future.filter((p: any) => p.id === series.id)).toEqual([]);
});

test("bell acknowledgements and snoozes do not complete or reschedule plans", async ({
  page,
  request,
}) => {
  async function create(title: string) {
    const start = new Date(Date.now() - 5 * 60000).toISOString();
    const end = new Date(Date.now() + 55 * 60000).toISOString();
    const response = await request.post("/api/v1/plans", {
      data: {
        title,
        start,
        end,
        reminder_enabled: true,
        reminder_offsets: [0, 10],
      },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  const first = await create("QA 知道了不完成计划");
  await expect
    .poll(
      async () =>
        (await request.get("/api/v1/notifications").then((r) => r.json())).some(
          (n: any) => n.plan_id === first.id,
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "查看通知", exact: true }).click();
  const note = page
    .locator(".plan-notification")
    .filter({ hasText: first.title });
  await note.getByRole("button", { name: "知道了", exact: true }).click();
  expect(
    (await request.get(`/api/v1/plans/${first.id}`).then((r) => r.json()))
      .status,
  ).toBe("planned");
  await page.keyboard.press("Escape");
  const second = await create("QA 稍后只推迟本次通知");
  await expect
    .poll(
      async () =>
        (await request.get("/api/v1/notifications").then((r) => r.json())).some(
          (n: any) => n.plan_id === second.id,
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  const rules = () =>
    request
      .get("/api/v1/reminders")
      .then((r) => r.json())
      .then((rows) =>
        rows.filter((r: any) => r.calendar_event_id === second.id),
      );
  const before = await rules();
  await page.reload();
  await page.getByRole("button", { name: "查看通知", exact: true }).click();
  await page
    .locator(".plan-notification")
    .filter({ hasText: second.title })
    .getByRole("button", { name: "10 分钟后提醒", exact: true })
    .click();
  expect(await rules()).toEqual(before);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(
    page.locator(".plan-notification").filter({ hasText: second.title }),
  ).toContainText("稍后提醒");
  await page.screenshot({ path: resolve(shots, "notifications.png") });
});
