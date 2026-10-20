import { expect, test } from "vitest";
import type { CalendarEvent } from "./api";
import {
  groupPlanEvents,
  isRoutine,
  repeatLabel,
  selectCalendarEvents,
} from "./planPresentation";

test("a series stays one row across per-occurrence edits and completion filters", () => {
  const events = [
    {
      id: "one",
      title: "日常",
      start: "2090-10-20",
      end: "2090-10-21",
      all_day: true,
      recurrence: "daily",
      status: "completed",
    },
    {
      id: "one",
      title: "仅这次调整",
      start: "2090-10-21",
      end: "2090-10-22",
      all_day: true,
      recurrence: "daily",
      status: "planned",
    },
    {
      id: "one",
      title: "之后的新规则",
      start: "2090-10-22",
      end: "2090-10-23",
      all_day: true,
      recurrence: "weekly",
      status: "planned",
    },
    {
      id: "two",
      title: "单次会议",
      start: "2090-10-22",
      end: "2090-10-23",
      all_day: true,
      recurrence: "none",
      status: "planned",
    },
  ] as CalendarEvent[];
  const pending = groupPlanEvents(events, "planned", "2090-10-20");
  expect(pending).toHaveLength(2);
  expect(pending[0].values).toHaveLength(3);
  expect(pending[0].completed).toBe(1);
  expect(groupPlanEvents(events, "completed", "2090-10-20")).toHaveLength(1);
  expect(isRoutine(events[0])).toBe(true);
  expect(isRoutine({ ...events[0], calendar_display: "always" })).toBe(false);
  expect(isRoutine(events[3])).toBe(false);
});

test("a summary says the actual interval and stopping condition", () => {
  expect(
    repeatLabel({
      recurrence: "weekly",
      repeat_interval: 2,
      repeat_count: 5,
    } as CalendarEvent),
  ).toBe("每 2 周 · 共 5 次");
  expect(
    repeatLabel({
      recurrence: "daily",
      repeat_interval: 1,
      repeat_until: "2026-12-01",
    } as CalendarEvent),
  ).toBe("每天 · 截至 2026-12-01");
});

test("one-off plans retain a visible slot before prominent repeat plans", () => {
  const values = [
    { id: "r1", recurrence: "weekly", start: "2026-10-20T01:00:00Z" },
    { id: "r2", recurrence: "weekly", start: "2026-10-20T02:00:00Z" },
    { id: "once", recurrence: "none", start: "2026-10-20T12:00:00Z" },
  ] as CalendarEvent[];
  expect(selectCalendarEvents(values, 2).map((event) => event.id)).toEqual([
    "r1",
    "once",
  ]);
});
