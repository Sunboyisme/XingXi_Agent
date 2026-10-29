type CalendarView = "month" | "week";
type PlanLocation = {
  view: CalendarView | "todo";
  calendarView: CalendarView;
  anchor: string;
};
const key = "xiaoxi-plan-location";

export function readPlanLocation(today: string): PlanLocation {
  const fallback: PlanLocation = {
    view: "month",
    calendarView: "month",
    anchor: today,
  };
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    if (!value || !["todo", "month", "week"].includes(value.view))
      return fallback;
    const validDate =
      typeof value.anchor === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value.anchor) &&
      Number.isFinite(Date.parse(value.anchor)) &&
      new Date(value.anchor).toISOString().slice(0, 10) === value.anchor;
    return {
      view: value.view,
      calendarView: value.calendarView === "week" ? "week" : "month",
      anchor: validDate ? value.anchor : today,
    };
  } catch {
    return fallback;
  }
}

export function storePlanLocation(value: PlanLocation) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Keep the current view usable. */
  }
}
