import type { CalendarEvent } from "./api";
import { zonedInput } from "./calendarMonth";

const timeFormats = new Map<string, Intl.DateTimeFormat>();
function clockFormat(timezone: string, sameDay: boolean) {
  const key = `${timezone}|${sameDay}`;
  let format = timeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      ...(sameDay ? {} : { month: "numeric", day: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
    });
    if (timeFormats.size >= 32) timeFormats.clear();
    timeFormats.set(key, format);
  }
  return format;
}

export function planStartTime(event: CalendarEvent, timezone: string) {
  return clockFormat(timezone, true).format(new Date(event.start));
}

export function planTimeRange(event: CalendarEvent, timezone: string) {
  if (event.all_day) return "未定时";
  const sameDay =
    zonedInput(event.start, timezone).slice(0, 10) ===
    zonedInput(event.end, timezone).slice(0, 10);
  const format = clockFormat(timezone, sameDay);
  return `${format.format(new Date(event.start))}–${format.format(new Date(event.end))}`;
}

export type WeekPlacement = {
  event: CalendarEvent;
  top: number;
  bottom: number;
  lane: number;
  lanes: number;
};

/** Fit the complete local day; reserve one readable line for short plans. */
export function fitWeekPlans(
  events: CalendarEvent[],
  day: string,
  timezone: string,
  height: number,
): WeekPlacement[] {
  const minimum = Math.min(1440, (18 / Math.max(1, height)) * 1440);
  const minute = (value: string) =>
    Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
  const plans = events
    .filter((event) => !event.all_day)
    .map((event) => {
      const first = zonedInput(event.start, timezone);
      const last = zonedInput(event.end, timezone);
      const start = first.slice(0, 10) < day ? 0 : minute(first);
      const localEnd = last.slice(0, 10) > day ? 1440 : minute(last);
      const end =
        localEnd > start
          ? localEnd
          : Math.min(
              1440,
              start + (Date.parse(event.end) - Date.parse(event.start)) / 60000,
            );
      const top = Math.max(0, Math.min(start, 1440 - minimum));
      return {
        event,
        top,
        bottom: Math.min(1440, Math.max(end, top + minimum)),
        lane: 0,
        lanes: 1,
      };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster: WeekPlacement[] = [];
  let clusterEnd = 0;
  const finish = () => {
    const ends: number[] = [];
    for (const plan of cluster) {
      let lane = ends.findIndex((end) => end <= plan.top);
      if (lane < 0) lane = ends.length;
      ends[lane] = plan.bottom;
      plan.lane = lane;
    }
    for (const plan of cluster) plan.lanes = ends.length;
  };
  for (const plan of plans) {
    if (cluster.length && plan.top >= clusterEnd) {
      finish();
      cluster = [];
      clusterEnd = 0;
    }
    cluster.push(plan);
    clusterEnd = Math.max(clusterEnd, plan.bottom);
  }
  finish();
  return plans;
}
