import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  CalendarPage,
  eventsOnDay,
  nextPlanEnd,
  zonedISO,
} from "./CalendarPage";
import type { CalendarEvent } from "@/lib/api";
const mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: mock }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("calendar uses the selected timezone and exclusive all-day ending", () => {
  expect(zonedISO("2026-10-20T09:00", "Asia/Shanghai")).toBe(
    "2026-10-20T01:00:00.000Z",
  );
  expect(zonedISO("2026-03-08T09:00", "America/New_York")).toBe(
    "2026-03-08T13:00:00.000Z",
  );
  expect(() => zonedISO("2026-03-08T02:30", "America/New_York")).toThrow();
  const events = [
    { id: "a", start: "2026-10-20", end: "2026-10-22", all_day: true },
  ] as CalendarEvent[];
  expect(eventsOnDay(events, "2026-10-21", "Asia/Shanghai")).toHaveLength(1);
  expect(eventsOnDay(events, "2026-10-22", "Asia/Shanghai")).toHaveLength(0);
});

test("a later start moves the end to one hour after it", () => {
  expect(nextPlanEnd("2026-10-23T15:30", "2026-10-22T16:00", false)).toBe(
    "2026-10-23T16:30",
  );
  expect(nextPlanEnd("2026-10-23T23:30", "2026-10-23T23:45", false)).toBe(
    "2026-10-24T00:30",
  );
  expect(nextPlanEnd("2026-10-23", "2026-10-22", true)).toBe("2026-10-23");
  expect(nextPlanEnd("2026-10-23T09:00", "2026-10-23T10:30", false)).toBe(
    "2026-10-23T10:30",
  );
});

test("creates an all-day plan with reminders off and retains calendar/week views", async () => {
  mock.mockResolvedValue([]);
  render(<CalendarPage refresh={vi.fn().mockResolvedValue(undefined)} />);
  await waitFor(() =>
    expect(mock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/plans\?start=/),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "2026-10-19 添加计划" }));
  fireEvent.change(screen.getByLabelText("计划名称"), {
    target: { value: "认真读书" },
  });
  expect((screen.getByLabelText("指定时间") as HTMLInputElement).checked).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "开始" }));
  fireEvent.click(
    screen.getByRole("button", { name: "2026年10月20日 星期二" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  fireEvent.click(screen.getByRole("button", { name: "结束（含当天）" }));
  fireEvent.click(
    screen.getByRole("button", { name: "2026年10月21日 星期三" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  fireEvent.click(screen.getByRole("button", { name: "保存计划" }));
  await waitFor(() =>
    expect(mock).toHaveBeenCalledWith(
      "/plans",
      "POST",
      expect.objectContaining({
        title: "认真读书",
        start: "2026-10-20",
        end: "2026-10-22",
        all_day: true,
        reminder_enabled: false,
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "周历" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "月历" })).toBeNull();
  expect(document.querySelector(".holiday-source")).toBeNull();
  expect(screen.queryByRole("button", { name: "列表" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "周历" }));
  expect(document.querySelector(".plan-week-grid")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "日历" }));
  expect(document.querySelector(".plan-month-grid")).not.toBeNull();
});

test("month view folds weekly and monthly repeats into one agenda entry", async () => {
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const end = tomorrow.toISOString().slice(0, 10);
  mock.mockResolvedValue([
    {
      id: "once",
      title: "今天的一次安排",
      notes: "",
      start: today,
      end,
      all_day: true,
      timezone: "Asia/Shanghai",
      status: "planned",
      recurrence: "none",
      series_start: today,
      series_end: end,
      series_all_day: true,
      occurrence_start: today,
      reminder_offsets: [],
    },
    {
      id: "weekly",
      title: "每周跑步",
      notes: "",
      start: today,
      end,
      all_day: true,
      timezone: "Asia/Shanghai",
      status: "planned",
      recurrence: "weekly",
      series_start: today,
      series_end: end,
      series_all_day: true,
      occurrence_start: today,
      reminder_offsets: [],
    },
  ]);
  render(<CalendarPage refresh={vi.fn().mockResolvedValue(undefined)} />);
  expect(await screen.findByText("今天的一次安排")).toBeTruthy();
  expect(screen.queryByText("每周跑步")).toBeNull();
  fireEvent.click(
    await screen.findByRole("button", {
      name: `${today} 重复事项 1 项`,
    }),
  );
  expect(
    await screen.findByRole("heading", { name: `${today} 的重复事项` }),
  ).toBeTruthy();
  expect(screen.getByText("每周跑步")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /完成本次 每周跑步/ }),
  ).toBeTruthy();
});

test("today agenda request opens the day list instead of the edit form", async () => {
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  mock.mockResolvedValue([
    {
      id: "once",
      title: "一项待办",
      notes: "",
      start: today,
      end: tomorrow.toISOString().slice(0, 10),
      all_day: true,
      timezone: "Asia/Shanghai",
      status: "planned",
      recurrence: "none",
      reminder_offsets: [],
    },
  ]);
  const onOpened = vi.fn();
  render(
    <CalendarPage
      refresh={vi.fn().mockResolvedValue(undefined)}
      openAgenda={{ day: today, tab: "todo" }}
      onOpened={onOpened}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: `${today} 的待办事项` }),
  ).toBeTruthy();
  expect(screen.queryByText("安排一件小事")).toBeNull();
  expect(onOpened).toHaveBeenCalled();
});
