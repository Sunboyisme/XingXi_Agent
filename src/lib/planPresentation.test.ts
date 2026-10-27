import { expect, test } from "vitest";
import type { CalendarEvent } from "./api";
import { isRepeating, isRoutine } from "./planPresentation";

test("repeating plans stay out of the calendar unless always displayed", () => {
  const daily = { recurrence: "daily" } as CalendarEvent;
  const once = { recurrence: "none" } as CalendarEvent;
  expect(isRepeating(daily)).toBe(true);
  expect(isRepeating(once)).toBe(false);
  expect(isRoutine(daily)).toBe(true);
  expect(isRoutine({ ...daily, calendar_display: "always" })).toBe(false);
  expect(isRoutine(once)).toBe(false);
});
