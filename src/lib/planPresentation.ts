import type { CalendarEvent } from "./api";

export const isRepeating = (event: CalendarEvent) =>
  Boolean(event.recurrence && event.recurrence !== "none");
export const isRoutine = (event: CalendarEvent) =>
  isRepeating(event) && event.calendar_display !== "always";

export function selectCalendarEvents(events: CalendarEvent[], limit: number) {
  return [...events]
    .sort(
      (a, b) =>
        Number(isRepeating(a)) - Number(isRepeating(b)) ||
        a.start.localeCompare(b.start),
    )
    .slice(0, limit)
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function repeatLabel(event: CalendarEvent) {
  if (!isRepeating(event)) return "不重复";
  const unit = { daily: "天", weekly: "周", monthly: "月", none: "" }[
    event.recurrence
  ];
  const interval = event.repeat_interval || 1;
  const label =
    interval === 1
      ? { daily: "每天", weekly: "每周", monthly: "每月", none: "" }[
          event.recurrence
        ]
      : `每 ${interval} ${unit}`;
  return `${label}${event.repeat_until ? ` · 截至 ${event.repeat_until}` : event.repeat_count ? ` · 共 ${event.repeat_count} 次` : ""}`;
}

export function groupPlanEvents(
  events: CalendarEvent[],
  filter: string,
  today: string,
) {
  const grouped = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const values = grouped.get(event.id) || [];
    values.push(event);
    grouped.set(event.id, values);
  }
  return [...grouped.values()]
    .flatMap((values) => {
      const matching = values.filter(
        (event) => filter === "all" || event.status === filter,
      );
      if (!matching.length) return [];
      const event =
        matching.find(
          (item) =>
            item.status === "planned" &&
            (item.all_day
              ? item.end > today
              : Date.parse(item.end) > Date.now()),
        ) || matching[0];
      return [
        {
          event,
          values,
          completed: values.filter((item) => item.status === "completed")
            .length,
        },
      ];
    })
    .sort((a, b) => a.event.start.localeCompare(b.event.start));
}
