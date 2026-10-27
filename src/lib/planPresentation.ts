import type { CalendarEvent } from "./api";

export const isRepeating = (event: CalendarEvent) =>
  Boolean(event.recurrence && event.recurrence !== "none");
export const isRoutine = (event: CalendarEvent) =>
  isRepeating(event) && event.calendar_display !== "always";
