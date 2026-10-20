import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { selectCalendarDate } from "./helpers/calendarPicker";

test.skip(
  process.env.BAI_IMPROVEMENTS_QA !== "1",
  "Uses a separate QA data space",
);
const shots = resolve(".local-data/qa-improvements013/screenshots");
test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
});
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "计划", exact: true }),
  ).toBeVisible();
});

test("sidebar resizes by dragging and restores its width", async ({ page }) => {
  const handle = page.getByRole("separator", { name: "调整聊天侧栏宽度" });
  const before = (await page.locator(".chat-sidebar").boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 76, box.y + 100, { steps: 8 });
  await page.mouse.up();
  expect(
    (await page.locator(".chat-sidebar").boundingBox())!.width,
  ).toBeGreaterThan(before + 60);
  await page.reload();
  await expect(handle).toHaveAttribute("aria-valuenow", /29[0-9]|30[0-9]/);
  await page.screenshot({ path: resolve(shots, "sidebar.png") });
  await handle.dblclick();
});

test("calendar holiday badges, double-click, configurable reminders and persistence", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "计划", exact: true }).click();
  // Select October 2026 independent of the host clock.
  const heading = page.locator(".plan-heading h1");
  for (
    let i = 0;
    i < 30 && !(await heading.textContent())?.match(/2026年\s*10月/);
    i++
  ) {
    const text = (await heading.textContent())!.replace(/\s/g, "");
    const [, y, m] = text.match(/(\d+)年(\d+)月/)!;
    await page
      .getByRole("button", {
        name: Number(y) * 12 + Number(m) > 2026 * 12 + 10 ? "上一期" : "下一期",
        exact: true,
      })
      .click();
  }
  await expect(heading).toHaveText(/2026年\s*10月/);
  await expect(
    page.locator(
      '.plan-day:has([aria-label="2026-10-08 添加计划"]) .plan-lunar',
    ),
  ).toHaveText("寒露");
  await expect(
    page.locator(
      '.plan-day:has([aria-label="2026-10-23 添加计划"]) .plan-lunar',
    ),
  ).toHaveText("霜降");
  await expect(
    page.locator(
      '.plan-day:has([aria-label="2026-10-10 添加计划"]) .plan-lunar',
    ),
  ).toHaveText("九月");
  await expect(
    page.locator(
      '.plan-day:has([aria-label="2026-10-01 添加计划"]) .holiday-label',
    ),
  ).toContainText("休");
  await expect(
    page.locator(
      '.plan-day:has([aria-label="2026-10-01 添加计划"]) .plan-lunar',
    ),
  ).toHaveText("国庆节");
  await expect(
    page.locator(
      '.plan-day:has([aria-label="2026-10-10 添加计划"]) .holiday-label',
    ),
  ).toContainText("班");
  await expect(
    page.locator(
      '.plan-day:has([aria-label="2026-10-17 添加计划"]) .holiday-label',
    ),
  ).toHaveCount(0);
  const day = page.locator('.plan-day:has([aria-label="2026-10-20 添加计划"])');
  await day.dblclick({ position: { x: 40, y: 55 } });
  await page.getByLabel("计划名称", { exact: true }).fill("QA013 自选提醒时间");
  await page.getByLabel("设置提醒时间", { exact: true }).check();
  await selectCalendarDate(page, "提醒时间", "2026-10-20", "18:45");
  await expect(page.getByLabel("已经完成", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: resolve(shots, "calendar-editor.png") });
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const events = await request
    .get("/api/v1/calendar/events")
    .then((r) => r.json());
  const event = events.find((e: any) => e.title === "QA013 自选提醒时间");
  expect(event.reminder_time).toBe("18:45");
  const reminders = await request
    .get("/api/v1/reminders")
    .then((r) => r.json());
  expect(
    reminders.find((r: any) => r.id === event.reminder_id).due_at,
  ).toContain("10:45:00");
  await page.reload();
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await expect(page.locator(".plan-lunar").first()).toBeVisible();
  await expect(page.locator(".calendar-loading")).toHaveCount(0);
  await page.screenshot({ path: resolve(shots, "calendar-month.png") });
  await page.setViewportSize({ width: 720, height: 650 });
  await expect(page.locator(".holiday-source")).toHaveCount(0);
  await page.screenshot({ path: resolve(shots, "calendar-narrow.png") });
  await request.delete(`/api/v1/calendar/events/${event.id}`);
});

test("month-only calendar shows 2027 festivals without an annual leave table", async ({
  page,
}) => {
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "周历", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "月历", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".holiday-source")).toHaveCount(0);
  const heading = page.locator(".plan-heading h1");
  for (let i = 0; i < 36; i++) {
    const [, y, m] = (await heading.textContent())!
      .replace(/\s/g, "")
      .match(/(\d+)年(\d+)月/)!;
    const current = Number(y) * 12 + Number(m),
      target = 2027 * 12 + 2;
    if (current === target) break;
    await page
      .getByRole("button", {
        name: current < target ? "下一期" : "上一期",
        exact: true,
      })
      .click();
  }
  await expect(heading).toHaveText(/2027年\s*2月/);
  const eve = page.locator('.plan-day:has([aria-label="2027-02-05 添加计划"])');
  await expect(eve.locator(".plan-lunar")).toHaveText("除夕");
  await expect(eve.locator(".plan-lunar")).toHaveAttribute(
    "title",
    /腊月廿九.*除夕/,
  );
  await expect(eve.locator(".holiday-label")).toHaveCount(0);
  await expect(
    page.locator(
      '.plan-day:has([aria-label="2027-02-06 添加计划"]) .plan-lunar',
    ),
  ).toHaveText("春节");
  await expect(
    page.locator(
      '.plan-day:has([aria-label="2027-02-04 添加计划"]) .plan-lunar',
    ),
  ).toHaveText("立春");
  await page.screenshot({
    path: resolve(shots, "calendar-2027-festivals.png"),
  });
  await page.setViewportSize({ width: 720, height: 650 });
  await expect(eve.locator(".plan-lunar")).toBeVisible();
  const dayBox = (await eve.boundingBox())!,
    festivalBox = (await eve.locator(".plan-lunar").boundingBox())!;
  expect(festivalBox.x + festivalBox.width).toBeLessThanOrEqual(
    dayBox.x + dayBox.width,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: resolve(shots, "calendar-2027-narrow.png") });
  await page.getByRole("button", { name: "周历", exact: true }).click();
  await expect(page.locator(".plan-week-grid")).toBeVisible();
  await expect(page.locator(".holiday-source")).toHaveCount(0);
});

test("bundled skill, ZIP drag preview and separate runtime configuration", async ({
  page,
}) => {
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "技能", exact: true }).click();
  await expect(
    page.locator(".skill-card").filter({ hasText: "text-notes" }),
  ).toBeVisible();
  // Use a dragged SKILL.md; ZIPs and folders go through this same upload route.
  await page.locator(".skill-dropzone").evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        ["---\nname: qa-dropped\ndescription: A drop test\n---\nA local test"],
        "SKILL.md",
        { type: "text/markdown" },
      ),
    );
    element.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect(page.getByRole("dialog")).toContainText("qa-dropped");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".skill-runtime-overview")).toHaveCount(0);
  await page.getByRole("tab", { name: "脚本环境", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "脚本环境", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByLabel("Python 解释器路径", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(shots, "skill-runtime.png") });
  await page.getByRole("tab", { name: "技能", exact: true }).click();
  await page.screenshot({ path: resolve(shots, "skills.png") });
});

test("date-only and timed reminders use the shared calendar and persist independent times", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await page.getByRole("menuitem", { name: /普通计划/ }).click();
  await page.getByLabel("计划名称", { exact: true }).fill("QA013 独立提醒时间");
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await expect(page.locator(".datetime-popover .calendar-time")).toHaveCount(0);
  await expect(page.locator('.calendar-editor input[type="date"]')).toHaveCount(
    0,
  );
  await page.screenshot({
    path: resolve(shots, "all-day-calendar-picker.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByLabel("指定时间", { exact: true }).check();
  await selectCalendarDate(page, "开始", "2026-10-21", "09:00");
  await selectCalendarDate(page, "结束", "2026-10-21", "10:00");
  await page.getByLabel("设置提醒时间", { exact: true }).check();
  await selectCalendarDate(page, "提醒时间", "2026-10-20", "20:30");
  await page.getByRole("button", { name: "提醒时间", exact: true }).click();
  await page.screenshot({ path: resolve(shots, "timed-reminder-picker.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const events = await request
    .get("/api/v1/calendar/events")
    .then((r) => r.json());
  const event = events.find((e: any) => e.title === "QA013 独立提醒时间");
  expect(event.reminder_at).toBe("2026-10-20T12:30:00.000000+00:00");
  const reminders = await request
    .get("/api/v1/reminders")
    .then((r) => r.json());
  expect(reminders.find((r: any) => r.id === event.reminder_id).due_at).toBe(
    event.reminder_at,
  );
  await page.reload();
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page
    .getByRole("button", { name: "09:00 QA013 独立提醒时间", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "提醒时间", exact: true }),
  ).toContainText("20:30");
  await selectCalendarDate(page, "开始", "2026-10-21", "08:30");
  await expect(
    page.getByRole("button", { name: "提醒时间", exact: true }),
  ).toContainText("20:30");
  await page.keyboard.press("Escape");
  await request.delete(`/api/v1/calendar/events/${event.id}`);
});
