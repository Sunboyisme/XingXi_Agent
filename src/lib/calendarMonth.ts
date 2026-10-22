import type { CalendarEvent, CalendarEventWrite } from "./api";
import { isRepeating } from "./planPresentation";

export function dateMove(key: string, days: number) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function zonedInput(value: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
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

/** Allocate shared lanes across each week while every segment keeps its record. */
export function monthSegments(
  days: string[],
  eventsByDay: Map<string, CalendarEvent[]>,
  zone: string,
) {
  type Chain = {
    key: string;
    entries: { index: number; event: CalendarEvent }[];
    lane?: number;
  };
  const chains: Chain[] = [];
  const active = new Map<string, Chain[]>();
  days.forEach((day, index) => {
    const values = [...(eventsByDay.get(day) || [])].sort(
      (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id),
    );
    for (const event of values) {
      const key = bandKey(event, zone);
      const candidates = (active.get(key) || []).filter(
        (chain) => chain.entries.at(-1)!.index === index - 1,
      );
      const chain =
        candidates.find((item) => item.entries.at(-1)!.event.id === event.id) ||
        candidates[0];
      if (chain) chain.entries.push({ index, event });
      else {
        const created = { key, entries: [{ index, event }] };
        chains.push(created);
        active.set(key, [...(active.get(key) || []), created]);
      }
    }
  });
  const result = new Map<string, MonthSegment[]>(days.map((day) => [day, []]));
  for (let week = 0; week < days.length; week += 7) {
    const occupied: number[] = [];
    const portions = chains
      .map((chain) => ({
        chain,
        entries: chain.entries.filter(
          (entry) => entry.index >= week && entry.index < week + 7,
        ),
      }))
      .filter((portion) => portion.entries.length)
      .sort(
        (a, b) =>
          a.entries[0].index - b.entries[0].index ||
          b.entries.length - a.entries.length ||
          a.chain.key.localeCompare(b.chain.key),
      );
    for (const { chain, entries } of portions) {
      const mask = entries.reduce(
        (value, entry) => value | (1 << (entry.index - week)),
        0,
      );
      let lane = 0;
      while ((occupied[lane] || 0) & mask) lane++;
      chain.lane = lane;
      occupied[lane] = (occupied[lane] || 0) | mask;
      for (const entry of entries) {
        const previous = entry.index > chain.entries[0].index;
        const next = entry.index < chain.entries.at(-1)!.index;
        result
          .get(days[entry.index])!
          .push({
            event: entry.event,
            lane,
            joinLeft: previous && entry.index % 7 !== 0,
            joinRight: next && entry.index % 7 !== 6,
            continuesBefore: previous && entry.index % 7 === 0,
            continuesAfter: next && entry.index % 7 === 6,
          });
      }
    }
  }
  return result;
}
