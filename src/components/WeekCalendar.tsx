import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent } from "@/lib/api";
import { occurrenceOrderKey } from "@/lib/calendarMonth";
import { fitWeekPlans, planTimeRange, planStartTime } from "@/lib/calendarWeek";

const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function WeekCalendar({
  days,
  today,
  selected,
  eventsByDay,
  timezone,
  onOpenDay,
  onCreate,
  onEdit,
}: {
  days: string[];
  today: string;
  selected: string;
  eventsByDay: Map<string, CalendarEvent[]>;
  timezone: string;
  onOpenDay: (day: string, tab?: "todo" | "repeat") => void;
  onCreate: (day: string) => void;
  onEdit: (day: string, event: CalendarEvent) => void;
}) {
  const timeline = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(480);
  useLayoutEffect(() => {
    const node = timeline.current;
    if (!node) return;
    const measure = () => setHeight(Math.max(1, node.clientHeight));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const placements = useMemo(
    () =>
      new Map(
        days.map((day) => [
          day,
          fitWeekPlans(eventsByDay.get(day) || [], day, timezone, height),
        ]),
      ),
    [days, eventsByDay, timezone, height],
  );
  const allDay = days.map((day) =>
    (eventsByDay.get(day) || []).filter((event) => event.all_day),
  );
  const hasAllDay = allDay.some((events) => events.length > 0);
  const tickStep = height < 180 ? 4 : 2;
  return (
    <div className="fit-week-view">
      <div className="fit-week-header">
        <span aria-hidden="true" />
        {days.map((day, index) => (
          <button
            type="button"
            className="fit-week-date"
            key={day}
            data-calendar-day={day}
            data-today={day === today}
            aria-current={day === today ? "date" : undefined}
            aria-pressed={day === selected}
            aria-controls="plan-day-sidebar"
            aria-label={`${day} ${weekdays[index]} 查看当天计划`}
            onClick={() => onOpenDay(day)}
          >
            <span>{weekdays[index]}</span>
            <strong>{Number(day.slice(8))}</strong>
          </button>
        ))}
      </div>
      {hasAllDay && (
        <div className="fit-week-allday">
          <span>未定时</span>
          {days.map((day, index) => (
            <div
              key={day}
              data-calendar-day={day}
              onDoubleClick={(event) => {
                if (!(event.target as HTMLElement).closest("button"))
                  onCreate(day);
              }}
            >
              {allDay[index].length > 0 && (
                <button
                  type="button"
                  className="fit-week-all-summary"
                  aria-label={`${day} 未定时计划 ${allDay[index].length} 项：${allDay[index].map((event) => event.title).join("、")}`}
                  aria-controls="plan-day-sidebar"
                  onClick={() => onOpenDay(day)}
                >
                  {allDay[index].length} 项
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div
        className="fit-week-timeline"
        ref={timeline}
        aria-label="一周完整时间轴，00:00 至 24:00"
      >
        <div className="fit-week-axis" aria-hidden="true">
          {Array.from(
            { length: 24 / tickStep + 1 },
            (_, index) => index * tickStep,
          ).map((hour) => (
            <span key={hour} style={{ top: `${(hour / 24) * 100}%` }}>
              {String(hour).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        <div className="plan-week-grid">
          {days.map((day) => (
            <div
              key={day}
              className="fit-week-column"
              data-calendar-day={day}
              data-today={day === today}
              onDoubleClick={(event) => {
                if (!(event.target as HTMLElement).closest("button"))
                  onCreate(day);
              }}
            >
              {Array.from({ length: 25 }, (_, hour) => (
                <span
                  aria-hidden="true"
                  className={`fit-week-rule ${hour % tickStep === 0 ? "is-major" : ""}`}
                  key={hour}
                  style={{ top: `${(hour / 24) * 100}%` }}
                />
              ))}
              {(placements.get(day) || []).map(
                ({ event, top, bottom, lane, lanes }) => (
                  <button
                    type="button"
                    className={`week-event fit-week-event ${event.status === "completed" ? "is-completed" : event.status === "cancelled" ? "is-cancelled" : ""} ${lanes > 1 ? "is-narrow" : ""}`}
                    key={occurrenceOrderKey(event)}
                    style={{
                      top: `${(top / 1440) * 100}%`,
                      height: `calc(${((bottom - top) / 1440) * 100}% - 1px)`,
                      left: `calc(${(lane / lanes) * 100}% + 3px)`,
                      right: `calc(${((lanes - lane - 1) / lanes) * 100}% + 3px)`,
                    }}
                    aria-label={`${event.title}，${planTimeRange(event, timezone)}${event.status === "completed" ? "，已完成" : event.status === "cancelled" ? "，已取消" : ""}`}
                    aria-controls="plan-day-sidebar"
                    onClick={() => onEdit(day, event)}
                  >
                    <span className="fit-event-start">
                      {planStartTime(event, timezone)}
                    </span>
                    <strong>{event.title}</strong>
                  </button>
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
