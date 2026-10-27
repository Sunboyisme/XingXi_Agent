import type { CalendarEvent, CalendarEventWrite } from "./api";
import { isRepeating } from "./planPresentation";

export function dateMove(key: string, days: number) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 指定时区下今天的日期键 YYYY-MM-DD。 */
export function zonedToday(zone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return ["year", "month", "day"]
    .map((name) => parts.find((part) => part.type === name)?.value)
    .join("-");
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
const localTimes = new Map<string, string>();

export function zonedInput(value: string, zone: string) {
  const key = `${zone}|${value}`;
  const cached = localTimes.get(key);
  if (cached) return cached;
  let format = zoneFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    if (zoneFormats.size >= 16) zoneFormats.clear();
    zoneFormats.set(zone, format);
  }
  const parts = format.formatToParts(new Date(value));
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const result = `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  if (localTimes.size >= 1024) localTimes.clear();
  localTimes.set(key, result);
  return result;
}

export function zonedISO(input: string, zone: string) {
  const wanted = Date.parse(`${input}:00Z`);
  let guess = wanted;
  for (let i = 0; i < 3; i++)
    guess +=
      wanted -
      Date.parse(`${zonedInput(new Date(guess).toISOString(), zone)}:00Z`);
  const result = new Date(guess).toISOString();
  if (zonedInput(result, zone) !== input)
    throw new Error("此时区不存在这个时间，请调整时间");
  return result;
}

export function shiftedPlan(
  event: CalendarEvent,
  sourceDay: string,
  targetDay: string,
): CalendarEventWrite {
  if (
    isRepeating(event) ||
    event.status === "cancelled" ||
    event.status === "deleted" ||
    event.status === "ended"
  )
    throw new Error("这项计划不支持拖动，重复计划请从编辑页调整。");
  const days =
    (Date.parse(`${targetDay}T00:00Z`) - Date.parse(`${sourceDay}T00:00Z`)) /
    86400000;
  if (!Number.isInteger(days)) throw new Error("目标日期无效");
  const shift = (value: string) => {
    const local = zonedInput(value, event.timezone);
    const moved = zonedISO(
      dateMove(local.slice(0, 10), days) + local.slice(10),
      event.timezone,
    );
    return new Date(
      Date.parse(moved) + (((Date.parse(value) % 60000) + 60000) % 60000),
    ).toISOString();
  };
  return {
    ...event,
    status: event.status,
    start: event.all_day ? dateMove(event.start, days) : shift(event.start),
    end: event.all_day ? dateMove(event.end, days) : shift(event.end),
    reminder_at: event.reminder_at ? shift(event.reminder_at) : null,
  };
}

export type MonthSegment = {
  event: CalendarEvent;
  lane: number;
  joinLeft: boolean;
  joinRight: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

function bandKey(event: CalendarEvent, zone: string) {
  const start = event.all_day ? event.start : zonedInput(event.start, zone);
  const end = event.all_day ? event.end : zonedInput(event.end, zone);
  const span =
    Date.parse(`${end.slice(0, 10)}T00:00Z`) -
    Date.parse(`${start.slice(0, 10)}T00:00Z`);
  return JSON.stringify([
    event.title.trim(),
    event.status,
    event.all_day,
    start.slice(10),
    end.slice(10),
    span,
    event.timezone,
    isRepeating(event) ? event.id : "",
  ]);
}

export const occurrenceOrderKey = (event: CalendarEvent) =>
  `${event.id}:${event.occurrence_start || event.start}`;

export function orderDayEvents(
  events: CalendarEvent[],
  zone: string,
  keys: string[] = [],
) {
  const positions = new Map(keys.map((key, index) => [key, index]));
  const localStarts = new Map(
    events.map((event) => [
      event,
      event.all_day ? event.start : zonedInput(event.start, zone),
    ]),
  );
  return [...events].sort((a, b) => {
    const left =
      positions.get(occurrenceOrderKey(a)) ?? Number.MAX_SAFE_INTEGER;
    const right =
      positions.get(occurrenceOrderKey(b)) ?? Number.MAX_SAFE_INTEGER;
    return (
      left - right ||
      Number(b.all_day) - Number(a.all_day) ||
      localStarts.get(a)!.localeCompare(localStarts.get(b)!) ||
      a.id.localeCompare(b.id)
    );
  });
}

/** Keep each day's true order. Join only segments whose lanes also agree. */
export function monthSegments(
  days: string[],
  eventsByDay: Map<string, CalendarEvent[]>,
  zone: string,
  orders: Record<string, string[]> = {},
) {
  const values = days.map((day) =>
    orderDayEvents(eventsByDay.get(day) || [], zone, orders[day]),
  );
  return new Map(
    days.map((day, index) => [
      day,
      values[index].map((event, lane): MonthSegment => {
        const key = bandKey(event, zone);
        const previous = values[index - 1]?.[lane];
        const next = values[index + 1]?.[lane];
        const before = Boolean(previous && bandKey(previous, zone) === key);
        const after = Boolean(next && bandKey(next, zone) === key);
        return {
          event,
          lane,
          joinLeft: before && index % 7 !== 0,
          joinRight: after && index % 7 !== 6,
          continuesBefore: before && index % 7 === 0,
          continuesAfter: after && index % 7 === 6,
        };
      }),
    ]),
  );
}
