import { expect, test } from "vitest";
import type { CalendarEvent } from "./api";
import { dateMove, monthSegments, shiftedPlan } from "./calendarMonth";

function event(
  id: string,
  day: string,
  changes: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    title: "微调 2day",
    start: day,
    end: dateMove(day, 1),
    all_day: true,
    timezone: "Asia/Shanghai",
    recurrence: "none",
    status: "planned",
    reminder_enabled: true,
    reminder_offsets: [540],
    ...changes,
  } as CalendarEvent;
}

test("adjacent names connect across week rows without merging records, and gaps break", () => {
  const days = Array.from({ length: 14 }, (_, index) =>
    dateMove("2026-10-19", index),
  );
  const map = new Map(
    [24, 25, 26, 28].map((day) => {
      const key = `2026-10-${day}`;
      return [key, [event(String(day), key)]];
    }),
  );
  const layout = monthSegments(days, map, "Asia/Shanghai");
  expect(layout.get("2026-10-25")![0]).toMatchObject({
    joinLeft: true,
    joinRight: false,
    continuesAfter: true,
  });
  expect(layout.get("2026-10-26")![0]).toMatchObject({
    continuesBefore: true,
    joinLeft: false,
  });
  expect(layout.get("2026-10-26")![0].event.id).toBe("26");
  expect(layout.get("2026-10-28")![0]).toMatchObject({
    joinLeft: false,
    continuesBefore: false,
  });
});

test("different status or time stays separate and overlapping events use distinct lanes", () => {
  const days = ["2026-10-19", "2026-10-20"];
  const a = event("a", days[0]);
  const b = event("b", days[0], { title: "另一件事" });
  const c = event("c", days[1], { status: "completed" });
  const layout = monthSegments(
    days,
    new Map([
      [days[0], [a, b]],
      [days[1], [c]],
    ]),
    "Asia/Shanghai",
  );
  expect(
    new Set(layout.get(days[0])!.map((segment) => segment.lane)).size,
  ).toBe(2);
  expect(layout.get(days[1])![0].joinLeft).toBe(false);
});

test("dragging a later segment shifts the complete original multi-day span", () => {
  const original = event("multi", "2026-10-19", { end: "2026-10-22" });
  const moved = shiftedPlan(original, "2026-10-21", "2026-10-24");
  expect(moved.start).toBe("2026-10-22");
  expect(moved.end).toBe("2026-10-25");
  expect(moved.reminder_offsets).toEqual([540]);
});

test("dragging keeps local clock, sub-minute precision and reminder offsets", () => {
  const original = event("timed", "2026-10-25", {
    all_day: false,
    start: "2026-10-24T23:00:20.123Z",
    end: "2026-10-25T00:00:20.123Z",
    reminder_offsets: [-10, 0],
  });
  const moved = shiftedPlan(original, "2026-10-25", "2026-10-27");
  expect(moved.start).toBe("2026-10-26T23:00:20.123Z");
  expect(moved.end).toBe("2026-10-27T00:00:20.123Z");
  expect(moved.reminder_offsets).toEqual([-10, 0]);
  expect(() =>
    shiftedPlan(
      { ...original, recurrence: "daily" },
      "2026-10-25",
      "2026-10-27",
    ),
  ).toThrow("不支持拖动");
});
