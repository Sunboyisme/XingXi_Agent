import { TodoPage } from "./TodoPage";
import { PlanCompletionButton, PlanViewSwitch } from "./PlanControls";
import { Hint } from "./common";
import { PlanAgendaList } from "./PlanAgendaList";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Pencil,
  Plus,
  Repeat2,
  Trash2,
  RotateCcw,
  X,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { api, type CalendarEvent, type CalendarEventWrite } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { ConfirmDelete, ErrorNotice } from "./common";
import { DateTimePicker } from "./DateTimePicker";
import { SoftSelect } from "./ui/soft-select";
import { holidayOn } from "@/lib/holidays";
import { lunarDate } from "@/lib/lunarCalendar";
import { isRepeating, isRoutine } from "@/lib/planPresentation";

import {
  dateMove,
  zonedInput,
  zonedISO,
  shiftedPlan,
  monthSegments,
  orderDayEvents,
  occurrenceOrderKey,
  type MonthSegment,
} from "@/lib/calendarMonth";
export { dateMove, zonedInput, zonedISO } from "@/lib/calendarMonth";

export function nextPlanEnd(start: string, end: string, allDay: boolean) {
  const startDay = start.slice(0, 10);
  if (allDay) return end.slice(0, 10) < startDay ? startDay : end.slice(0, 10);
  const normalizedStart = start.length === 10 ? `${start}T09:00` : start;
  const normalizedEnd = end.length === 10 ? `${end}T10:00` : end;
  if (normalizedEnd > normalizedStart) return normalizedEnd;
  return new Date(Date.parse(`${normalizedStart}:00Z`) + 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
}
export function eventsOnDay(
  events: CalendarEvent[],
  day: string,
  zone: string,
) {
  return eventsBetween(events, day, dateMove(day, 1), zone);
}

function eventsBetween(
  events: CalendarEvent[],
  first: string,
  last: string,
  zone: string,
) {
  const begin = zonedISO(`${first}T00:00`, zone),
    end = zonedISO(`${last}T00:00`, zone);
  return events.filter((e) =>
    e.all_day
      ? e.start < last && e.end > first
      : Date.parse(e.start) < Date.parse(end) &&
        Date.parse(e.end) > Date.parse(begin),
  );
}

export function CalendarPage({
  timezone = "Asia/Shanghai",
  refresh,
  openEventId,
  onOpened,
  createRequested,
  openOccurrenceStart,
  openAgenda: requestedAgenda,
  openTodoId,
}: {
  timezone?: string;
  openTodoId?: string;
  refresh: () => Promise<void>;
  openEventId?: string;
  onOpened?: () => void;
  createRequested?: number;
  openOccurrenceStart?: string | null;
  openAgenda?: { day: string; tab: "todo" | "repeat" } | null;
}) {
  const today = zonedInput(new Date().toISOString(), timezone).slice(0, 10);
  const [todoView, setTodoView] = useState(Boolean(openTodoId));
  useEffect(() => { if (openTodoId) setTodoView(true); }, [openTodoId]);
  useEffect(() => { if (openEventId || requestedAgenda || createRequested) setTodoView(false); }, [openEventId, requestedAgenda, createRequested]);
  const [anchor, setAnchor] = useState(today);
  const [view, setView] = useState<"month" | "week">("month");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [dayOrders, setDayOrders] = useState<Record<string, string[]>>({});
  const [orderSaving, setOrderSaving] = useState(false);
  const orderLock = useRef(false);
  function orderedDay(day: string) {
    return valuesByDay.get(day) || [];
  }

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const monthGrid = useRef<HTMLDivElement>(null);
  const weekScroll = useRef<HTMLDivElement>(null);
  const [visibleEvents, setVisibleEvents] = useState(3);
  const [editor, setEditor] = useState(false);
  const [editorMode, setEditorMode] = useState<"single" | "repeat">("single");
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [editScope, setEditScope] = useState<"this" | "future" | "series">(
    "this",
  );
  const [dayList, setDayList] = useState("");
  const [agendaTab, setAgendaTab] = useState<"todo" | "repeat">("todo");
  const [agendaNotice, setAgendaNotice] = useState("");
  const requestSequence = useRef(0);
  const [deleting, setDeleting] = useState<CalendarEvent | null>(null);
  const [cancelling, setCancelling] = useState<CalendarEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<{
    event: CalendarEvent;
    sourceDay: string;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const suppressClickUntil = useRef(0);
  const [dropDay, setDropDay] = useState("");
  const [draggingId, setDraggingId] = useState("");
  const moveLock = useRef(false);
  const [moveNotice, setMoveNotice] = useState("");
  const [form, setForm] = useState({
    title: "",
    notes: "",
    start: today,
    end: today,
    all_day: true,
    reminder_enabled: false,
    reminder_time: "09:00",
    reminder_at: "",
    status: "planned" as "planned" | "completed" | "ended" | "deleted",
    recurrence: "none" as "none" | "daily" | "weekly" | "monthly",
    repeat_interval: 1,
    repeat_end_mode: "never" as "never" | "until" | "count",
    repeat_until: dateMove(today, 30),
    repeat_count: 10,
    calendar_display: "summary" as "summary" | "always",
    reminder_values: [`${today}T09:00`],
  });
  const formBaseline = useRef<typeof form | null>(null);
  const first = `${anchor.slice(0, 7)}-01`;
  const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(
    Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 0),
  ).getUTCDate();
  const begin = dateMove(first, -offset),
    count = Math.ceil((offset + daysInMonth) / 7) * 7;
  const weekOffset = (new Date(`${anchor}T00:00:00Z`).getUTCDay() + 6) % 7;
  const weekStart = dateMove(anchor, -weekOffset);
  const days = useMemo(
    () => Array.from({ length: count }, (_, i) => dateMove(begin, i)),
    [begin, count],
  );
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => dateMove(weekStart, i)),
    [weekStart],
  );
  const valuesByDay = useMemo(
    () =>
      new Map(
        [...new Set([...days, ...weekDays, dayList].filter(Boolean))].map(
          (day) => [
            day,
            orderDayEvents(
              eventsOnDay(events, day, timezone),
              timezone,
              dayOrders[day],
            ),
          ],
        ),
      ),
    [days, weekDays, dayList, events, timezone, dayOrders],
  );
  const hasAllDayEvents = weekDays.some((day) =>
    eventsOnDay(events, day, timezone).some(
      (event) => event.all_day && !isRoutine(event),
    ),
  );
  const lunarDates = useMemo(
    () => new Map([...days, ...weekDays].map((day) => [day, lunarDate(day)])),
    [days, weekDays],
  );
  useEffect(() => {
    if (
      view !== "month" ||
      !monthGrid.current ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const observer = new ResizeObserver(([entry]) => {
      const cellHeight = entry.contentRect.height / (count / 7);
      setVisibleEvents(
        Math.max(0, Math.min(3, Math.floor((cellHeight - 52) / 25))),
      );
    });
    observer.observe(monthGrid.current);
    return () => observer.disconnect();
  }, [view, count, todoView]);
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const start = view === "week" ? weekStart : begin;
      const end =
        view === "week" ? dateMove(weekStart, 7) : dateMove(begin, count);
      const query = `start=${start}&end=${end}&timezone=${encodeURIComponent(timezone)}`;
      const [values, orders] = await Promise.all([
        api<CalendarEvent[]>(`/plans?${query}`),
        api<Record<string, string[]>>(`/plans/order?${query}`),
      ]);
      if (sequence === requestSequence.current) {
        setEvents(values);
        setDayOrders(orders);
        setError("");
      }
    } catch (e) {
      if (sequence === requestSequence.current) setError((e as Error).message);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [begin, count, view, weekStart, timezone]);
  useEffect(() => {
    void load();
  }, [load]);
  const edit = useCallback(
    (
      day: string,
      selectedEvent?: CalendarEvent,
      scope: "this" | "future" | "series" = "this",
      source?: CalendarEvent,
      changes?: Partial<typeof form>,
    ) => {
      const event = source || selectedEvent;
      setEditing(selectedEvent || null);
      setEditScope(scope);
      setEditorMode(event && isRepeating(event) ? "repeat" : "single");
      const first = event?.start;
      const last = event?.end;
      const allDay = event?.all_day;
      const nextForm: typeof form = event
        ? {
            ...event,
            all_day: Boolean(allDay),
            status:
              event.recurrence !== "none"
                ? ((event.series_status || "planned") as
                    "planned" | "completed" | "ended" | "deleted")
                : event.status === "cancelled"
                  ? "planned"
                  : event.status,
            recurrence: event.recurrence || "none",
            repeat_interval: event.repeat_interval || 1,
            repeat_end_mode: event.repeat_until
              ? "until"
              : event.repeat_count
                ? "count"
                : "never",
            repeat_until:
              event.repeat_until || dateMove((first || day).slice(0, 10), 30),
            repeat_count:
              scope === "future" && event.repeat_count
                ? Math.max(1, event.repeat_count - event.occurrence_index)
                : event.repeat_count || 10,
            calendar_display: event.calendar_display,
            reminder_values: (event.reminder_offsets?.length
              ? event.reminder_offsets
              : [allDay ? 540 : 0]
            ).map((offset) => {
              const base = allDay
                ? `${first}T00:00`
                : zonedInput(first!, event.timezone);
              return new Date(Date.parse(`${base}:00Z`) + offset * 60000)
                .toISOString()
                .slice(0, 16);
            }),
            reminder_time: event.reminder_time || "09:00",
            reminder_at: event.reminder_at
              ? zonedInput(event.reminder_at, event.timezone)
              : "",
            start: allDay ? first! : zonedInput(first!, event.timezone),
            end: allDay
              ? dateMove(last!, -1)
              : zonedInput(last!, event.timezone),
          }
        : {
            title: "",
            notes: "",
            start: day,
            end: day,
            all_day: true,
            reminder_enabled: false,
            reminder_time: "09:00",
            reminder_at: "",
            status: "planned",
            recurrence: "none",
            repeat_interval: 1,
            repeat_end_mode: "never",
            repeat_until: dateMove(day, 30),
            repeat_count: 10,
            calendar_display: "summary",
            reminder_values: [`${day}T09:00`],
          };
      formBaseline.current = nextForm;
      setForm({ ...nextForm, ...changes });
      setError("");
      setDayList("");
      setEditor(true);
    },
    [],
  );
  async function changeEditScope(scope: "this" | "future" | "series") {
    if (!editing || busy) return;
    setBusy(true);
    setError("");
    const baseline = formBaseline.current;
    const changes = Object.fromEntries(
      (Object.keys(form) as (keyof typeof form)[])
        .filter(
          (key) =>
            baseline &&
            JSON.stringify(form[key]) !== JSON.stringify(baseline[key]),
        )
        .map((key) => [key, form[key]]),
    ) as Partial<typeof form>;
    try {
      const source =
        scope === "series"
          ? await api<CalendarEvent>(`/plans/${editing.id}`)
          : editing;
      edit(editing.start.slice(0, 10), editing, scope, source, changes);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function startCreate(
    day: string,
    recurrence: "none" | "daily" | "weekly" | "monthly" = "none",
  ) {
    edit(day);
    setEditorMode(recurrence === "none" ? "single" : "repeat");
    setForm((value) => ({
      ...value,
      recurrence,
      all_day: true,
      start: day,
      end: day,
      repeat_interval: 1,
      repeat_end_mode: "never",
    }));
  }
  function openAgenda(day: string, tab?: "todo" | "repeat") {
    const values = orderedDay(day);
    const hasTodo = values.some((event) => !isRepeating(event));
    const hasRepeat = values.some(isRepeating);
    setAgendaTab(tab || (hasTodo ? "todo" : hasRepeat ? "repeat" : "todo"));
    setAgendaNotice("");
    setDayList(day);
  }
  useEffect(() => {
    if (!openEventId) return;
    let live = true;
    void api<CalendarEvent>(
      `/plans/${openEventId}${openOccurrenceStart ? `?occurrence_start=${encodeURIComponent(openOccurrenceStart)}` : ""}`,
    )
      .then((event) => {
        if (!live) return;
        edit(event.start.slice(0, 10), {
          ...event,
          occurrence_start: openOccurrenceStart || event.start,
        });
        onOpened?.();
      })
      .catch((error: Error) => {
        if (live) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, [openEventId, openOccurrenceStart, edit, onOpened]);
  useEffect(() => {
    if (!requestedAgenda) return;
    setAnchor(requestedAgenda.day);
    openAgenda(requestedAgenda.day, requestedAgenda.tab);
    onOpened?.();
  }, [requestedAgenda, onOpened]);
  useEffect(() => {
    if (createRequested) edit(today);
  }, [createRequested, edit]);
  useEffect(() => {
    if (view === "week" && weekScroll.current)
      weekScroll.current.scrollTop = 8 * 48;
  }, [view, weekStart]);
  function move(amount: number) {
    if (view === "week") {
      setAnchor(dateMove(anchor, amount * 7));
      return;
    }
    const value = new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`);
    value.setUTCMonth(value.getUTCMonth() + amount);
    setAnchor(value.toISOString().slice(0, 10));
  }
  function payload(): CalendarEventWrite {
    const zone = editing?.timezone || timezone;
    const onlyThis = Boolean(
      editing && isRepeating(editing) && editScope === "this",
    );
    return {
      ...form,
      recurrence:
        editorMode === "single" || onlyThis ? "none" : form.recurrence,
      repeat_until:
        editorMode === "repeat" &&
        !onlyThis &&
        form.recurrence !== "none" &&
        form.repeat_end_mode === "until"
          ? form.repeat_until
          : null,
      repeat_count:
        editorMode === "repeat" &&
        !onlyThis &&
        form.recurrence !== "none" &&
        form.repeat_end_mode === "count"
          ? form.repeat_count
          : null,
      calendar_display: form.calendar_display,
      reminder_offsets: form.reminder_values.map((value) =>
        Math.round(
          (Date.parse(`${value}:00Z`) -
            Date.parse(
              `${form.all_day ? form.start.slice(0, 10) + "T00:00" : form.start}:00Z`,
            )) /
            60000,
        ),
      ),
      start: form.all_day
        ? form.start.slice(0, 10)
        : zonedISO(form.start, zone),
      end: form.all_day
        ? dateMove(form.end.slice(0, 10), 1)
        : zonedISO(form.end, zone),
      timezone: zone,
      reminder_at:
        !form.all_day && form.reminder_at && form.reminder_at !== form.start
          ? zonedISO(form.reminder_at, zone)
          : null,
    };
  }
  async function save() {
    if (busy || editing?.status === "cancelled") return;
    setBusy(true);
    setError("");
    try {
      if (
        (form.end <= form.start && !form.all_day) ||
        (form.all_day && form.end < form.start)
      )
        throw new Error("结束时间不能早于开始时间；定时计划的结束须晚于开始");
      await api(
        editing ? `/plans/${editing.id}` : "/plans",
        editing ? "PUT" : "POST",
        {
          ...payload(),
          ...(editing
            ? {
                scope: isRepeating(editing) ? editScope : "series",
                occurrence_start: editing.occurrence_start || editing.start,
              }
            : {}),
        },
      );
      setEditor(false);
      await Promise.all([
        load(),
        refresh().catch(() =>
          setError("计划已保存，部分列表暂未刷新，请稍后刷新查看。"),
        ),
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function complete(event: CalendarEvent) {
    if (busy) return false;
    setBusy(true);
    try {
      const restoring = ["completed", "cancelled"].includes(event.status);
      await api(`/plans/${event.id}/action`, "POST", {
        action: restoring ? "restore" : "complete",
        occurrence_start: event.occurrence_start || event.start,
      });
      setAgendaNotice(
        restoring ? `已恢复「${event.title}」` : `已完成「${event.title}」`,
      );
      await Promise.all([
        load(),
        refresh().catch(() =>
          setError("操作已保存，部分列表暂未刷新，请稍后刷新查看。"),
        ),
      ]);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!agendaNotice) return;
    const timer = window.setTimeout(() => setAgendaNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [agendaNotice]);
  function toggleAllDay(checked: boolean) {
    setForm((value) => {
      const start = checked
        ? value.start.slice(0, 10)
        : `${value.start.slice(0, 10)}T09:00`;
      const end = checked
        ? value.end.slice(0, 10)
        : `${value.end.slice(0, 10)}T10:00`;
      return {
        ...value,
        all_day: checked,
        reminder_at: "",
        reminder_values: value.reminder_values.length
          ? value.reminder_values
          : [`${value.start.slice(0, 10)}T09:00`],
        start,
        end: nextPlanEnd(start, end, checked),
      };
    });
  }
  const monthValues = useMemo(
    () =>
      new Map(
        days.map((day) => [
          day,
          eventsOnDay(events, day, timezone).filter(
            (event) => !isRoutine(event),
          ),
        ]),
      ),
    [days, events, timezone],
  );
  const monthLayout = useMemo(
    () => monthSegments(days, monthValues, timezone, dayOrders),
    [days, monthValues, timezone, dayOrders],
  );
  function startDrag(
    pointer: PointerEvent<HTMLButtonElement>,
    event: CalendarEvent,
    day: string,
  ) {
    if (
      pointer.button !== 0 ||
      busy ||
      loading ||
      moveLock.current ||
      isRepeating(event) ||
      event.status === "cancelled" ||
      event.status === "ended"
    )
      return;
    drag.current = {
      event,
      sourceDay: day,
      x: pointer.clientX,
      y: pointer.clientY,
      active: false,
    };
    pointer.currentTarget.setPointerCapture(pointer.pointerId);
  }
  function updateDrag(pointer: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current) return;
    if (
      !current.active &&
      Math.hypot(pointer.clientX - current.x, pointer.clientY - current.y) < 7
    )
      return;
    current.active = true;
    pointer.preventDefault();
    setDraggingId(current.event.id);
    setDropDay(
      document
        .elementFromPoint(pointer.clientX, pointer.clientY)
        ?.closest<HTMLElement>("[data-calendar-day]")?.dataset.calendarDay ||
        "",
    );
  }
  async function finishDrag(pointer: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    drag.current = null;
    setDropDay("");
    setDraggingId("");
    if (!current?.active) return;
    suppressClickUntil.current = Date.now() + 500;
    const target = document
      .elementFromPoint(pointer.clientX, pointer.clientY)
      ?.closest<HTMLElement>("[data-calendar-day]")?.dataset.calendarDay;
    if (!target || target === current.sourceDay || moveLock.current) return;
    moveLock.current = true;
    setBusy(true);
    setError("");
    setMoveNotice("");
    try {
      const saved = await api<CalendarEvent>(
        `/plans/${current.event.id}`,
        "PUT",
        {
          ...shiftedPlan(current.event, current.sourceDay, target),
          scope: "series",
        },
      );
      setEvents((previous) =>
        previous.map((event) => (event.id === saved.id ? saved : event)),
      );
      setMoveNotice(`已将「${current.event.title}」移到 ${target}。`);
      await load();
      await refresh().catch(() => setError("改期已保存，部分列表暂未刷新。"));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      moveLock.current = false;
      setBusy(false);
    }
  }
  function cancelDrag() {
    drag.current = null;
    setDropDay("");
    setDraggingId("");
  }
  function monthEvent(segment: MonthSegment, day: string) {
    const event = segment.event;
    return (
      <Hint
        key={`${event.id}:${event.occurrence_start || event.start}`}
        label={`${event.title}\n${day}${isRepeating(event) ? " · 重复计划请从编辑页调整" : " · 可拖动改期"}`}
      >
        <button
          type="button"
          className={`day-event month-band ${event.status === "completed" ? "is-completed" : ""} ${event.status === "cancelled" ? "is-cancelled" : ""}`}
          data-join-left={segment.joinLeft}
          data-join-right={segment.joinRight}
          data-dragging={draggingId === event.id}
          data-movable={
            !isRepeating(event) &&
            !["cancelled", "ended", "deleted"].includes(event.status)
          }
          aria-label={`${day} ${event.title}${event.all_day ? " 全天" : ` ${timeLabel(event)}`}`}
          onPointerDown={(pointer) => startDrag(pointer, event, day)}
          onPointerMove={updateDrag}
          onPointerUp={(pointer) => void finishDrag(pointer)}
          onPointerCancel={cancelDrag}
          onClick={() => {
            if (Date.now() >= suppressClickUntil.current)
              openAgenda(day, isRepeating(event) ? "repeat" : "todo");
          }}
        >
          {segment.continuesBefore && (
            <ChevronLeft size={11} aria-hidden="true" />
          )}
          <span>
            {!segment.joinLeft
              ? `${event.all_day ? "" : timeLabel(event) + " "}${event.title}`
              : "\u00a0"}
          </span>
          {event.status === "completed" && <Check size={11} />}
          {segment.continuesAfter && (
            <ChevronRight size={11} aria-hidden="true" />
          )}
        </button>
      </Hint>
    );
  }
  const timeLabel = (e: CalendarEvent) =>
    e.all_day ? "全天" : zonedInput(e.start, timezone).slice(11);
  const eventButton = (e: CalendarEvent, day?: string) => (
    <Hint key={`${e.id}:${e.occurrence_start || e.start}`} label={e.title}>
      <button
        className={`day-event ${e.status === "completed" ? "is-completed" : e.status === "cancelled" ? "is-cancelled" : ""}`}
        onClick={() =>
          openAgenda(
            day ||
              (e.all_day
                ? e.start
                : zonedInput(e.start, timezone).slice(0, 10)),
            isRepeating(e) ? "repeat" : "todo",
          )
        }
      >
        <span>
          {!e.all_day && `${timeLabel(e)} `}
          {e.title}
          {e.status === "cancelled" && " · 已取消"}
        </span>
        {e.status === "completed" ? (
          <Check size={12} />
        ) : isRepeating(e) ? (
          <Repeat2 size={10} className="plan-event-repeat" />
        ) : null}
      </button>
    </Hint>
  );
  function weekEventPosition(event: CalendarEvent, day: string) {
    const dayStart = Date.parse(zonedISO(`${day}T00:00`, timezone));
    const nextDay = Date.parse(zonedISO(`${dateMove(day, 1)}T00:00`, timezone));
    const start = Math.max(Date.parse(event.start), dayStart);
    const end = Math.min(Date.parse(event.end), nextDay);
    return {
      top: ((start - dayStart) / 3600000) * 48,
      height: Math.max(24, ((end - start) / 3600000) * 48),
    };
  }
  const weekEventButton = (event: CalendarEvent, day: string, index = 0) => (
    <Hint
      key={`${event.id}:${event.occurrence_start || event.start}:${day}`}
      label={event.title}
    >
      <button
        className={`week-event ${event.status === "completed" ? "is-completed" : event.status === "cancelled" ? "is-cancelled" : ""}`}
        style={{
          ...weekEventPosition(event, day),
          zIndex: events.length - index + 1,
        }}
        onClick={() => openAgenda(day, isRepeating(event) ? "repeat" : "todo")}
      >
        <strong>
          {zonedInput(event.start, timezone).slice(11)} {event.title}
          {event.status === "cancelled" && " · 已取消"}
        </strong>
      </button>
    </Hint>
  );
  useEffect(() => {
    if (!moveNotice) return;
    const timer = window.setTimeout(() => setMoveNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [moveNotice]);
  async function saveOrder(keys: string[]) {
    if (!dayList || orderLock.current || busy || loading) return false;
    const day = dayList;
    orderLock.current = true;
    setOrderSaving(true);
    setError("");
    try {
      const result = await api<{ keys: string[] }>("/plans/order", "PUT", {
        day,
        timezone,
        keys,
      });
      setDayOrders((orders) => ({ ...orders, [day]: result.keys }));
      setAgendaNotice(keys.length ? "顺序已保存。" : "已恢复默认排序。");
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      orderLock.current = false;
      setOrderSaving(false);
    }
  }
  async function reorder(visibleKeys: string[]) {
    const selected = new Set(visibleKeys);
    let index = 0;
    // Reorder only this tab's instances, preserving the other tab's slots.
    const keys = orderedDay(dayList).map((event) => {
      const key = occurrenceOrderKey(event);
      return selected.has(key) ? visibleKeys[index++] : key;
    });
    return saveOrder(keys);
  }
  const dayValues = dayList ? orderedDay(dayList) : [];
  const todoCount = dayValues.filter((event) => !isRepeating(event)).length;
  const repeatCount = dayValues.filter(isRepeating).length;
  const selectedOccurrences = dayList
    ? dayValues.filter((event) =>
        agendaTab === "repeat" ? isRepeating(event) : !isRepeating(event),
      )
    : [];
  const weekRepeats = new Map(
    weekDays.map((day) => [day, orderedDay(day).filter(isRoutine)]),
  );
  const hasWeekRepeats = [...weekRepeats.values()].some(
    (values) => values.length,
  );
  if (todoView) return <TodoPage timezone={timezone} refresh={refresh} openId={openTodoId} onOpened={onOpened} onCalendar={(value) => { setTodoView(false); setView(value); }} />;
  return (
    <div className="calendar-page page-content">
      {error && !editor && (
        <ErrorNotice message={error} retry={() => void load()} />
      )}
      {moveNotice && (
        <p className="plan-move-notice" role="status">
          {moveNotice}
        </p>
      )}
      <div className="plan-calendar" data-view={view}>
        <div className="plan-toolbar">
          <div className="plan-heading">
            <h1>
              {Number(anchor.slice(0, 4))}
              <span>年</span> {Number(anchor.slice(5, 7))}
              <span>月</span>
            </h1>
          </div>
          <div className="calendar-period" aria-label="切换日期">
            <Button
              size="icon"
              variant="ghost"
              aria-label="上一期"
              onClick={() => move(-1)}
            >
              <ChevronLeft size={17} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAnchor(today)}>
              今天
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="下一期"
              onClick={() => move(1)}
            >
              <ChevronRight size={17} />
            </Button>
          </div>
          <div className="plan-toolbar-actions">
            <PlanViewSwitch
              value={view}
              onChange={(next) => {
                if (next === "todo") setTodoView(true);
                else setView(next);
              }}
            />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button size="sm" className="plan-add-trigger">
                  <CalendarPlus size={15} />
                  添加计划
                  <ChevronDown size={13} />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="plan-add-menu"
                  align="end"
                  sideOffset={8}
                  collisionPadding={16}
                >
                  <DropdownMenu.Label className="plan-add-menu-label">
                    新建
                  </DropdownMenu.Label>
                  <DropdownMenu.Item
                    className="plan-add-menu-item"
                    onSelect={() => startCreate(anchor, "none")}
                  >
                    <CalendarPlus size={17} />
                    <span>
                      <strong>普通计划</strong>
                      <small>安排一次性的日历计划</small>
                    </span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="plan-add-menu-item"
                    onSelect={() => startCreate(anchor, "daily")}
                  >
                    <Repeat2 size={17} />
                    <span>
                      <strong>重复日程</strong>
                      <small>按每天、每周或每月自动安排</small>
                    </span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
        {view === "month" && (
          <div className="plan-weekdays">
            {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(
              (day) => (
                <span key={day}>{day}</span>
              ),
            )}
          </div>
        )}
        {view === "week" && (
          <div className="plan-weekdays">
            {weekDays.map((day) => (
              <div
                className="plan-weekday"
                data-today={day === today}
                key={day}
              >
                <span>
                  {
                    ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][
                      weekDays.indexOf(day)
                    ]
                  }
                  <strong data-today={day === today}>
                    {Number(day.slice(8))}
                  </strong>
                </span>
                <small
                  className={`plan-week-lunar ${lunarDates.get(day)?.festival ? "festival" : lunarDates.get(day)?.term ? "solar-term" : ""}`}
                >
                  {lunarDates.get(day)?.festival ||
                    lunarDates.get(day)?.term ||
                    lunarDates.get(day)?.label}
                </small>
              </div>
            ))}
          </div>
        )}
        {loading && (
          <span className="calendar-loading" role="status">
            正在读取计划…
          </span>
        )}
        {view === "week" ? (
          <div className="plan-week-view">
            {hasWeekRepeats && (
              <div className="plan-week-repeats">
                <span className="plan-week-repeats-label">
                  <Repeat2 size={13} />
                  重复
                </span>
                {weekDays.map((day) => {
                  const values = weekRepeats.get(day) || [];
                  return (
                    <div key={day}>
                      {values.length > 0 && (
                        <Hint
                          label={values.map((event) => event.title).join("\n")}
                        >
                          <button
                            aria-label={`${day} 重复事项 ${values.length} 项`}
                            onClick={() => openAgenda(day, "repeat")}
                          >
                            <Repeat2 size={11} />
                            {values.length}
                          </button>
                        </Hint>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {hasAllDayEvents && (
              <div className="plan-week-allday">
                <span className="plan-week-allday-label">全天</span>
                {weekDays.map((day) => (
                  <div
                    key={day}
                    onDoubleClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button"))
                        edit(day);
                    }}
                  >
                    {orderedDay(day)
                      .filter((event) => event.all_day && !isRoutine(event))
                      .map((event) => (
                        <button
                          key={`${event.id}:${event.occurrence_start || event.start}`}
                          className={`week-allday-event ${event.status === "completed" ? "is-completed" : event.status === "cancelled" ? "is-cancelled" : ""}`}
                          onClick={() =>
                            openAgenda(
                              day,
                              isRepeating(event) ? "repeat" : "todo",
                            )
                          }
                        >
                          {event.title}
                          {event.status === "cancelled" && " · 已取消"}
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            )}
            <div className="plan-week-scroll" ref={weekScroll}>
              <div className="plan-week-times">
                {Array.from({ length: 24 }, (_, hour) => (
                  <span key={hour} style={{ top: hour * 48 }}>
                    {String(hour).padStart(2, "0")}:00
                  </span>
                ))}
              </div>
              <div className="plan-week-grid">
                {weekDays.map((day) => (
                  <div
                    className="plan-week-column"
                    data-today={day === today}
                    key={day}
                    onDoubleClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button"))
                        edit(day);
                    }}
                  >
                    {orderedDay(day)
                      .filter((event) => !event.all_day && !isRoutine(event))
                      .map((event, index) =>
                        weekEventButton(event, day, index),
                      )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div
            className="plan-month-grid"
            ref={monthGrid}
            style={{ gridTemplateRows: `repeat(${count / 7}, minmax(0, 1fr))` }}
          >
            {days.map((day) => {
              const values = orderedDay(day);
              const visibleValues = values.filter((event) => !isRoutine(event));
              const repeatedValues = values.filter(isRoutine);
              const segments = monthLayout.get(day) || [];
              const displayed = segments.filter(
                (segment) => segment.lane < visibleEvents,
              );
              return (
                <section
                  key={day}
                  className="plan-day"
                  data-calendar-day={day}
                  data-drop-target={dropDay === day}
                  data-outside={day.slice(0, 7) !== anchor.slice(0, 7)}
                  data-today={day === today}
                  data-holiday={holidayOn(day)?.kind}
                  onDoubleClick={(event) => {
                    if (!(event.target as HTMLElement).closest("button, a"))
                      edit(day);
                  }}
                >
                  <div className="plan-day-heading">
                    <button
                      className="plan-day-number"
                      aria-label={`${day} 添加计划`}
                      onClick={() => edit(day)}
                    >
                      {Number(day.slice(8))}
                    </button>
                    <Hint label={lunarDates.get(day)?.title}>
                      <span
                        className={`plan-lunar ${lunarDates.get(day)?.festival ? "festival" : lunarDates.get(day)?.term ? "solar-term" : ""}`}
                      >
                        {lunarDates.get(day)?.festival ||
                          lunarDates.get(day)?.term ||
                          lunarDates.get(day)?.label}
                      </span>
                    </Hint>
                    {holidayOn(day) && (
                      <Hint
                        label={`${holidayOn(day)!.name} · ${holidayOn(day)!.kind === "off" ? "放假" : "补班"}`}
                      >
                        <span
                          className={`holiday-label ${holidayOn(day)!.kind}`}
                        >
                          {!lunarDates.get(day)?.festival && (
                            <span>{holidayOn(day)!.name}</span>
                          )}
                          <b>{holidayOn(day)!.kind === "off" ? "休" : "班"}</b>
                        </span>
                      </Hint>
                    )}
                  </div>
                  <div className="plan-day-events">
                    <div className="plan-day-event-list">
                      {Array.from({ length: visibleEvents }, (_, lane) => {
                        const segment = displayed.find(
                          (value) => value.lane === lane,
                        );
                        return (
                          <div className="month-event-slot" key={lane}>
                            {segment ? monthEvent(segment, day) : null}
                          </div>
                        );
                      })}
                    </div>
                    <div className="plan-day-summary">
                      {visibleValues.length > displayed.length && (
                        <button
                          className="plan-more plan-more-ellipsis"
                          aria-label={`查看 ${day} 的全部计划`}
                          onClick={() =>
                            openAgenda(
                              day,
                              visibleValues.some((event) => !isRepeating(event))
                                ? "todo"
                                : "repeat",
                            )
                          }
                        >
                          ···
                        </button>
                      )}
                      {repeatedValues.length > 0 && (
                        <Hint
                          label={repeatedValues
                            .map(
                              (event) => `${timeLabel(event)} ${event.title}`,
                            )
                            .join("\n")}
                        >
                          <button
                            className="plan-daily-repeat-hint"
                            aria-label={`${day} 重复事项 ${repeatedValues.length} 项`}
                            onClick={() => openAgenda(day, "repeat")}
                          >
                            <Repeat2 size={11} />
                            <span>{repeatedValues.length}</span>
                          </button>
                        </Hint>
                      )}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
      <Dialog
        open={Boolean(dayList)}
        onOpenChange={(v) => {
          if (!v) {
            setDayList("");
            setAgendaNotice("");
          }
        }}
      >
        <DialogContent
          className="calendar-editor plan-agenda-dialog"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // Let the focused handle cancel a sort before Escape closes the dialog.
            if (
              event.target instanceof HTMLElement &&
              event.target.closest(".plan-agenda-list.is-sorting")
            )
              event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {dayList} 的{agendaTab === "repeat" ? "重复事项" : "待办事项"}
            </DialogTitle>
          </DialogHeader>
          <div className="plan-agenda-sticky-tabs">
            <div className="plan-agenda-tabs segmented" role="tablist">
              <button
                role="tab"
                aria-selected={agendaTab === "todo"}
                className={agendaTab === "todo" ? "selected" : ""}
                onClick={() => setAgendaTab("todo")}
              >
                待办事项 <span>{todoCount}</span>
              </button>
              <button
                role="tab"
                aria-selected={agendaTab === "repeat"}
                className={agendaTab === "repeat" ? "selected" : ""}
                onClick={() => setAgendaTab("repeat")}
              >
                重复 {repeatCount} 项
              </button>
            </div>
            <Button
              className="plan-order-reset"
              size="sm"
              variant="outline"
              disabled={
                busy || loading || orderSaving || !dayOrders[dayList]?.length
              }
              onClick={() => void saveOrder([])}
            >
              <RotateCcw size={14} />
              恢复默认排序
            </Button>
          </div>
          {error && <p role="alert">{error}</p>}
          {agendaNotice && (
            <p
              className="plan-agenda-feedback"
              role="status"
              aria-live="polite"
            >
              <Check size={14} />
              {agendaNotice}
            </p>
          )}
          <PlanAgendaList
            key={`${dayList}:${agendaTab}:${timezone}`}
            events={selectedOccurrences}
            disabled={busy || orderSaving || loading}
            onReorder={reorder}
            empty={
              <p className="plan-agenda-empty">
                {agendaTab === "repeat"
                  ? "这一天还没有重复安排。"
                  : "这一天还没有待办事项。"}
              </p>
            }
          >
            {(event) => (
              <>
                <PlanCompletionButton
                  status={event.status}
                  label={`${["completed", "cancelled"].includes(event.status) ? "恢复" : "完成"}${isRepeating(event) ? "本次" : ""} ${event.title} ${event.all_day ? event.start : zonedInput(event.start, timezone).slice(0, 10)}`}
                  disabled={busy}
                  onClick={() => void complete(event)}
                />
                <div className="plan-occurrence-content">
                  {eventButton(event, dayList)}
                </div>
                <Hint label={isRepeating(event) ? "删除单日计划安排" : "删除计划"}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    className="plan-agenda-delete"
                    aria-label={`${isRepeating(event) ? "删除单日计划" : "删除"} ${event.title}`}
                    onClick={() =>
                      isRepeating(event)
                        ? setCancelling(event)
                        : setDeleting(event)
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                </Hint>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="plan-agenda-edit"
                  aria-label={`编辑 ${event.title}`}
                  onClick={() => edit(event.start.slice(0, 10), event)}
                >
                  <Pencil size={13} />
                  编辑
                </Button>
              </>
            )}
          </PlanAgendaList>
          <div className="plan-agenda-create">
            <Button onClick={() => startCreate(dayList)}>
              <Plus size={15} />
              添加计划
            </Button>
            <div
              className="plan-agenda-repeat-actions"
              aria-label="添加重复计划"
            >
              {[
                ["daily", "每日重复"],
                ["weekly", "每周重复"],
                ["monthly", "每月重复"],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    startCreate(
                      dayList,
                      value as "daily" | "weekly" | "monthly",
                    )
                  }
                >
                  <Repeat2 size={13} />
                  {label}
                </Button>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={editor}
        onOpenChange={(v) => {
          if (!busy) setEditor(v);
        }}
      >
        <DialogContent className="calendar-editor">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? editorMode === "repeat"
                  ? "编辑重复日程"
                  : "看看这项计划"
                : editorMode === "repeat"
                  ? "安排重复日程"
                  : "安排一件小事"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              设置计划名称、日期与提醒时间。
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {error && <ErrorNotice message={error} />}
            {editing?.status === "cancelled" && (
              <p role="status" className="muted">
                本次已取消。恢复本次后可修改安排，其他日期继续按原规则执行。
              </p>
            )}
            <fieldset
              className="plan-editor-fields"
              disabled={busy || editing?.status === "cancelled"}
            >
              {editing && isRepeating(editing) && (
                <div className="form-field">
                  <Label htmlFor="plan-edit-scope">修改范围</Label>
                  <SoftSelect
                    id="plan-edit-scope"
                    label="修改范围"
                    value={editScope}
                    disabled={busy || editing.status === "cancelled"}
                    onValueChange={(value) =>
                      void changeEditScope(value as typeof editScope)
                    }
                    options={[
                      { value: "this", label: "仅本次" },
                      { value: "future", label: "本次及以后" },
                      { value: "series", label: "整个系列" },
                    ]}
                  />
                  <p className="muted">
                    {editScope === "this"
                      ? "仅调整所选这一次，其他日期保持原安排。"
                      : editScope === "future"
                        ? "从所选日期起使用新规则，之前的安排保留。"
                        : "将修改整个系列的规则；已有完成记录和单次调整会保留。"}
                  </p>
                </div>
              )}
              {editorMode === "repeat" && (
                <p className="plan-repeat-intro">
                  <Repeat2 size={16} />
                  <span>重复日程会自动排入日历，点击日期可查看每次安排。</span>
                </p>
              )}
              <div className="form-field">
                <Label htmlFor="plan-title">计划名称</Label>
                <Input
                  id="plan-title"
                  value={form.title}
                  maxLength={300}
                  required
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
              {editorMode === "repeat" &&
                (!editing || editScope !== "this") && (
                  <>
                    <div className="plan-repeat-settings">
                      <div className="form-field">
                        <Label htmlFor="plan-repeat">重复频率</Label>
                        <SoftSelect
                          id="plan-repeat"
                          label="重复频率"
                          value={form.recurrence}
                          onValueChange={(value) =>
                            setForm({
                              ...form,
                              recurrence: value as typeof form.recurrence,
                            })
                          }
                          options={[
                            { value: "daily", label: "每天" },
                            { value: "weekly", label: "每周" },
                            { value: "monthly", label: "每月" },
                          ]}
                        />
                      </div>
                      <div className="form-field">
                        <Label htmlFor="plan-repeat-interval">
                          间隔（
                          {form.recurrence === "daily"
                            ? "天"
                            : form.recurrence === "weekly"
                              ? "周"
                              : "月"}
                          ）
                        </Label>
                        <Input
                          id="plan-repeat-interval"
                          type="number"
                          min={1}
                          max={365}
                          value={form.repeat_interval}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              repeat_interval: Number(event.target.value),
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="plan-recurrence-options">
                      <div className="form-field">
                        <Label htmlFor="plan-calendar-display">月历显示</Label>
                        <SoftSelect
                          id="plan-calendar-display"
                          label="月历显示"
                          value={form.calendar_display}
                          disabled={busy}
                          onValueChange={(value) =>
                            setForm({
                              ...form,
                              calendar_display:
                                value as typeof form.calendar_display,
                            })
                          }
                          options={[
                            { value: "summary", label: "汇总为日常事项" },
                            { value: "always", label: "始终展开显示" },
                          ]}
                        />
                      </div>
                      <div className="plan-repeat-settings">
                        <div className="form-field">
                          <Label htmlFor="plan-repeat-end">重复结束</Label>
                          <SoftSelect
                            id="plan-repeat-end"
                            label="重复结束"
                            value={form.repeat_end_mode}
                            onValueChange={(value) =>
                              setForm({
                                ...form,
                                repeat_end_mode:
                                  value as typeof form.repeat_end_mode,
                              })
                            }
                            options={[
                              { value: "never", label: "永不结束" },
                              { value: "until", label: "截止日期" },
                              { value: "count", label: "重复次数" },
                            ]}
                          />
                        </div>
                        {form.repeat_end_mode === "until" && (
                          <div className="form-field">
                            <Label htmlFor="plan-repeat-until">
                              截止日期（含当天）
                            </Label>
                            <DateTimePicker
                              id="plan-repeat-until"
                              label="截止日期（含当天）"
                              dateOnly
                              value={form.repeat_until}
                              timezone={editing?.timezone || timezone}
                              onChange={(value) =>
                                setForm({ ...form, repeat_until: value })
                              }
                              disabled={busy}
                            />
                          </div>
                        )}
                        {form.repeat_end_mode === "count" && (
                          <div className="form-field">
                            <Label htmlFor="plan-repeat-count">
                              重复次数（含首次）
                            </Label>
                            <Input
                              id="plan-repeat-count"
                              type="number"
                              min={1}
                              max={10000}
                              required
                              value={form.repeat_count}
                              onChange={(event) =>
                                setForm({
                                  ...form,
                                  repeat_count: Number(event.target.value),
                                })
                              }
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              <div className="plan-time-toggle">
                <label className="plan-check">
                  <input
                    type="checkbox"
                    checked={!form.all_day}
                    onChange={(e) => toggleAllDay(!e.target.checked)}
                  />
                  指定时间
                </label>
                <span className="plan-time-hint">不勾选则按全天安排</span>
              </div>
              <div className="plan-editor-dates">
                <div className="form-field">
                  <Label htmlFor="plan-start">开始</Label>
                  <DateTimePicker
                    id="plan-start"
                    label="开始"
                    dateOnly={form.all_day}
                    timezone={editing?.timezone || timezone}
                    value={form.start}
                    disabled={busy}
                    onChange={(start) =>
                      setForm((value) => ({
                        ...value,
                        start,
                        end: nextPlanEnd(start, value.end, value.all_day),
                        reminder_values: value.reminder_values.map(
                          (reminder) =>
                            reminder === value.start
                              ? start
                              : value.all_day &&
                                  reminder.slice(0, 10) ===
                                    value.start.slice(0, 10)
                                ? start.slice(0, 10) + reminder.slice(10)
                                : reminder,
                        ),
                        reminder_at:
                          value.reminder_at === value.start
                            ? ""
                            : value.reminder_at,
                      }))
                    }
                  />
                </div>
                <div className="form-field">
                  <Label htmlFor="plan-end">
                    结束{form.all_day ? "（含当天）" : ""}
                  </Label>
                  <DateTimePicker
                    id="plan-end"
                    label={form.all_day ? "结束（含当天）" : "结束"}
                    dateOnly={form.all_day}
                    timezone={editing?.timezone || timezone}
                    value={form.end}
                    disabled={busy}
                    onChange={(end) => setForm({ ...form, end })}
                  />
                </div>
              </div>
              <div className="form-field">
                <Label htmlFor="plan-notes">备注</Label>
                <Textarea
                  id="plan-notes"
                  value={form.notes}
                  maxLength={6000}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>
              <label className="plan-check">
                <input
                  type="checkbox"
                  checked={form.reminder_enabled}
                  onChange={(e) =>
                    setForm({ ...form, reminder_enabled: e.target.checked })
                  }
                />
                设置提醒时间
              </label>
              {form.reminder_enabled && (
                <div className="plan-reminders-editor">
                  {form.reminder_values.map((value, index) => (
                    <div className="plan-reminder-row" key={index}>
                      <div className="form-field">
                        <Label htmlFor={`plan-reminder-${index}`}>
                          {form.reminder_values.length > 1
                            ? `提醒时间 ${index + 1}`
                            : "提醒时间"}
                        </Label>
                        <DateTimePicker
                          id={`plan-reminder-${index}`}
                          label={
                            form.reminder_values.length > 1
                              ? `提醒时间 ${index + 1}`
                              : "提醒时间"
                          }
                          timezone={editing?.timezone || timezone}
                          value={value}
                          disabled={busy}
                          onChange={(time) =>
                            setForm({
                              ...form,
                              reminder_values: form.reminder_values.map(
                                (item, i) => (i === index ? time : item),
                              ),
                            })
                          }
                        />
                      </div>
                      {form.reminder_values.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`移除提醒 ${index + 1}`}
                          onClick={() =>
                            setForm({
                              ...form,
                              reminder_values: form.reminder_values.filter(
                                (_, i) => i !== index,
                              ),
                            })
                          }
                        >
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={form.reminder_values.length >= 10 || busy}
                    onClick={() => {
                      const base =
                        form.reminder_values.at(-1) ||
                        `${form.start.slice(0, 10)}T09:00`;
                      setForm({
                        ...form,
                        reminder_values: [
                          ...form.reminder_values,
                          new Date(Date.parse(`${base}:00Z`) - 10 * 60000)
                            .toISOString()
                            .slice(0, 16),
                        ],
                      });
                    }}
                  >
                    <Plus size={14} />
                    添加提醒时间
                  </Button>
                </div>
              )}
            </fieldset>
            <DialogFooter>
              {editing &&
                isRepeating(editing) &&
                editing.status === "planned" && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setCancelling(editing);
                    }}
                  >
                    <X size={15} />
                    删除单日计划
                  </Button>
                )}
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDeleting(editing)}
                  disabled={busy}
                >
                  <Trash2 size={15} />
                  {editing.recurrence !== "none" ? "删除整个计划" : "删除"}
                </Button>
              )}
              <Button
                type="submit"
                disabled={
                  busy || editing?.status === "cancelled" || !form.title.trim()
                }
              >
                {busy ? "正在保存…" : "保存计划"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        open={Boolean(cancelling)}
        title="删除这一天的计划？"
        description="仅取消所选这一次及其提醒，其他日期继续按原规则执行。删除后可在当天事项中恢复本次。"
        label="删除单日计划"
        cancelLabel="保留本次"
        error={error}
        onClose={() => setCancelling(null)}
        onConfirm={async () => {
          if (!cancelling) return;
          try {
            await api(`/plans/${cancelling.id}/action`, "POST", {
              action: "cancel_occurrence",
              occurrence_start: cancelling.occurrence_start || cancelling.start,
            });
            const day = cancelling.all_day
              ? cancelling.start
              : zonedInput(cancelling.start, timezone).slice(0, 10);
            setCancelling(null);
            setEditor(false);
            setDayList(day);
            setAgendaTab("repeat");
            setAgendaNotice(
              `已删除单日计划「${cancelling.title}」，可点击恢复按钮恢复。`,
            );
            await Promise.all([
              load(),
              refresh().catch(() => setError("本次已取消，部分列表暂未刷新。")),
            ]);
          } catch (error) {
            setError((error as Error).message);
          }
        }}
      />
      <ConfirmDelete
        open={Boolean(deleting)}
        title={
          deleting?.recurrence !== "none"
            ? "删除整个重复计划？"
            : "删除这项计划？"
        }
        description={
          deleting?.recurrence !== "none"
            ? "已完成记录会保留，包括今天在内的未完成安排和后续提醒都会取消。"
            : "尚未触发的关联提醒也会取消。"
        }
        note={
          deleting?.recurrence !== "none"
            ? "仅删除某一天请使用「删除单日计划」，已完成历史会保留。"
            : undefined
        }
        cancelLabel={deleting?.recurrence !== "none" ? "保留系列" : "取消"}
        label={deleting?.recurrence !== "none" ? "删除整个计划" : "删除计划"}
        error={error}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            if (deleting.recurrence !== "none")
              await api(`/plans/${deleting.id}/action`, "POST", {
                action: "end_series",
              });
            else await api(`/plans/${deleting.id}`, "DELETE");
            setDeleting(null);
            setEditor(false);
            await Promise.all([load(), refresh()]);
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    </div>
  );
}
