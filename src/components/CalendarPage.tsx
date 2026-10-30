import { TodoPage } from "./TodoPage";
import { PlanCompletionButton, PlanViewSwitch } from "./PlanControls";
import { Hint } from "./common";
import { PlanAgendaList } from "./PlanAgendaList";
import { WeekCalendar } from "./WeekCalendar";
import { planTimeRange } from "@/lib/calendarWeek";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { readPlanLocation, storePlanLocation } from "@/lib/planLocation";
import { isRepeating, isRoutine } from "@/lib/planPresentation";

import {
  dateMove,
  zonedInput,
  zonedISO,
  zonedToday,
  shiftedPlan,
  monthSegments,
  orderDayEvents,
  occurrenceOrderKey,
  type MonthSegment,
} from "@/lib/calendarMonth";
import { errorMessage } from "@/lib/utils";

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

function emptyPlanForm(day: string) {
  return {
    title: "",
    notes: "",
    start: day,
    end: day,
    all_day: true,
    reminder_enabled: false,
    reminder_time: "09:00",
    reminder_at: "",
    status: "planned" as "planned" | "completed" | "ended" | "deleted",
    recurrence: "none" as "none" | "daily" | "weekly" | "monthly",
    repeat_interval: "1",
    repeat_end_mode: "never" as "never" | "until" | "count",
    repeat_until: dateMove(day, 30),
    repeat_count: "10",
    calendar_display: "summary" as "summary" | "always",
    reminder_values: [`${day}T09:00`],
  };
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
  sidebarOpen: providedSidebarOpen,
  onSidebarOpenChange,
  onCalendarVisibleChange,
}: {
  timezone?: string;
  openTodoId?: string;
  refresh: () => Promise<void>;
  openEventId?: string;
  onOpened?: () => void;
  createRequested?: number;
  openOccurrenceStart?: string | null;
  openAgenda?: { day: string; tab: "todo" | "repeat" } | null;
  sidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
  onCalendarVisibleChange?: (visible: boolean) => void;
}) {
  const today = zonedToday(timezone);
  const [savedLocation] = useState(() => readPlanLocation(today));
  const [todoView, setTodoView] = useState(
    Boolean(openTodoId) || savedLocation.view === "todo",
  );
  useEffect(() => {
    if (openTodoId) setTodoView(true);
  }, [openTodoId]);
  useEffect(() => {
    if (openEventId || requestedAgenda || createRequested) setTodoView(false);
  }, [openEventId, requestedAgenda, createRequested]);
  const [anchor, setAnchor] = useState(savedLocation.anchor);
  const [localSidebarOpen, setLocalSidebarOpen] = useState(false);
  const sidebarOpen = providedSidebarOpen ?? localSidebarOpen;
  function setSidebarOpen(open: boolean) {
    setLocalSidebarOpen(open);
    onSidebarOpenChange?.(open);
  }
  useLayoutEffect(() => {
    onCalendarVisibleChange?.(!todoView);
  }, [todoView, onCalendarVisibleChange]);
  const [view, setView] = useState<"month" | "week">(
    savedLocation.calendarView,
  );
  useEffect(() => {
    storePlanLocation({
      view: todoView ? "todo" : view,
      calendarView: view,
      anchor,
    });
  }, [todoView, view, anchor]);
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
  const [visibleEvents, setVisibleEvents] = useState(3);
  const [editor, setEditor] = useState(false);
  const [editorMode, setEditorMode] = useState<"single" | "repeat">("single");
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [editScope, setEditScope] = useState<"this" | "future" | "series">(
    "this",
  );
  const [dayList, setDayList] = useState(savedLocation.anchor);
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
  const [form, setForm] = useState(() => emptyPlanForm(today));
  const saveLock = useRef(false);
  const repeatSettings =
    editorMode === "repeat" && (!editing || editScope !== "this");
  const intervalError =
    repeatSettings &&
    (!/^\d+$/.test(form.repeat_interval) ||
      Number(form.repeat_interval) < 1 ||
      Number(form.repeat_interval) > 365)
      ? "请输入 1 至 365 的整数。"
      : "";
  const countError =
    repeatSettings &&
    form.repeat_end_mode === "count" &&
    (!/^\d+$/.test(form.repeat_count) ||
      Number(form.repeat_count) < 1 ||
      Number(form.repeat_count) > 10000)
      ? "请输入 1 至 10000 的整数。"
      : "";
  const untilError =
    repeatSettings &&
    form.repeat_end_mode === "until" &&
    (!form.repeat_until || form.repeat_until < form.start.slice(0, 10))
      ? "截止日期不能早于计划开始日期。"
      : "";
  const datesError = form.all_day
    ? form.end < form.start
      ? "结束日期不能早于开始日期。"
      : ""
    : form.end <= form.start
      ? "结束时间须晚于开始时间。"
      : "";
  const formInvalid =
    !form.title.trim() ||
    Boolean(intervalError || countError || untilError || datesError);
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
  const rangeStart = view === "week" ? weekStart : begin;
  const rangeEnd =
    view === "week" ? dateMove(weekStart, 7) : dateMove(begin, count);
  const requestRange = `${rangeStart}|${rangeEnd}|${timezone}`;
  const activeRange = useRef(requestRange);
  useLayoutEffect(() => {
    activeRange.current = requestRange;
    return () => {
      activeRange.current = "";
      requestSequence.current++;
    };
  }, [requestRange]);
  const load = useCallback(async () => {
    if (activeRange.current !== requestRange) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const query = `start=${rangeStart}&end=${rangeEnd}&timezone=${encodeURIComponent(timezone)}`;
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
      if (sequence === requestSequence.current) setError(errorMessage(e));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [rangeStart, rangeEnd, timezone, requestRange]);
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
            repeat_interval: String(event.repeat_interval || 1),
            repeat_end_mode: event.repeat_until
              ? "until"
              : event.repeat_count
                ? "count"
                : "never",
            repeat_until:
              event.repeat_until || dateMove((first || day).slice(0, 10), 30),
            repeat_count: String(
              scope === "future" && event.repeat_count
                ? Math.max(1, event.repeat_count - event.occurrence_index)
                : event.repeat_count || 10,
            ),
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
        : emptyPlanForm(day);
      formBaseline.current = nextForm;
      setForm({ ...nextForm, ...changes });
      setError("");
      setDayList(day);
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
      edit(dayList, editing, scope, source, changes);
    } catch (error) {
      setError(errorMessage(error));
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
      repeat_interval: "1",
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
    setSidebarOpen(true);
  }
  useEffect(() => {
    if (!openEventId) return;
    let live = true;
    void api<CalendarEvent>(
      `/plans/${openEventId}${openOccurrenceStart ? `?occurrence_start=${encodeURIComponent(openOccurrenceStart)}` : ""}`,
    )
      .then((event) => {
        if (!live) return;
        const day = event.all_day
          ? event.start
          : zonedInput(event.start, timezone).slice(0, 10);
        setAnchor(day);
        edit(day, {
          ...event,
          occurrence_start: openOccurrenceStart || event.start,
        });
        onOpened?.();
      })
      .catch((error) => {
        if (live) setError(errorMessage(error));
      });
    return () => {
      live = false;
    };
  }, [openEventId, openOccurrenceStart, edit, onOpened, timezone]);
  useEffect(() => {
    if (!requestedAgenda) return;
    setAnchor(requestedAgenda.day);
    openAgenda(requestedAgenda.day, requestedAgenda.tab);
    onOpened?.();
  }, [requestedAgenda, onOpened]);
  useEffect(() => {
    if (createRequested) {
      setAnchor(today);
      edit(today);
    }
  }, [createRequested, edit]);
  function move(amount: number) {
    if (view === "week") {
      const next = dateMove(anchor, amount * 7);
      setAnchor(next);
      setDayList(next);
      return;
    }
    const value = new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`);
    value.setUTCMonth(value.getUTCMonth() + amount);
    const next = value.toISOString().slice(0, 10);
    setAnchor(next);
    setDayList(next);
  }
  function payload(): CalendarEventWrite {
    const zone = editing?.timezone || timezone;
    const onlyThis = Boolean(
      editing && isRepeating(editing) && editScope === "this",
    );
    return {
      ...form,
      title: form.title.trim(),
      repeat_interval: repeatSettings ? Number(form.repeat_interval) : 1,
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
          ? Number(form.repeat_count)
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
    if (
      busy ||
      saveLock.current ||
      formInvalid ||
      editing?.status === "cancelled"
    )
      return;
    saveLock.current = true;
    setBusy(true);
    setError("");
    try {
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
      setError(errorMessage(e));
    } finally {
      saveLock.current = false;
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
      setError(errorMessage(e));
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
      setError(errorMessage(cause));
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
              edit(day, event);
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
  const eventButton = (event: CalendarEvent, day = anchor) => (
    <button
      type="button"
      key={occurrenceOrderKey(event)}
      className={`day-event sidebar-occurrence ${event.status === "completed" ? "is-completed" : event.status === "cancelled" ? "is-cancelled" : ""}`}
      aria-label={`编辑 ${event.title}，${planTimeRange(event, timezone)}`}
      onClick={() => edit(day, event)}
    >
      <span>
        {event.title}
        {isRepeating(event) && (
          <Repeat2
            size={11}
            className="plan-event-repeat"
            aria-label="重复计划"
          />
        )}
      </span>
      <small>
        {planTimeRange(event, timezone)}
        {event.status === "cancelled" ? " · 已取消" : ""}
      </small>
    </button>
  );
  function closeDaySidebar() {
    setSidebarOpen(false);
    setAgendaNotice("");
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>(
          '.window-titlebar .sidebar-toggle[aria-controls="plan-day-sidebar"]',
        )
        ?.focus({ preventScroll: true }),
    );
  }
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
      setError(errorMessage(cause));
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
  const dayHeading = `${Number(dayList.slice(5, 7))}月${Number(dayList.slice(8))}日`;
  const dayWeekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    new Date(`${dayList}T12:00:00Z`).getUTCDay()
  ];
  const dayLunar = lunarDate(dayList)
    .title.split(" · ")
    .slice(1)
    .join(" · ")
    .replace(/^农历\d+年/, "农历");
  const selectedOccurrences = dayList
    ? dayValues.filter((event) =>
        agendaTab === "repeat" ? isRepeating(event) : !isRepeating(event),
      )
    : [];
  if (todoView)
    return (
      <TodoPage
        timezone={timezone}
        refresh={refresh}
        openId={openTodoId}
        onOpened={onOpened}
        onCalendar={(value) => {
          setTodoView(false);
          setView(value);
        }}
      />
    );
  return (
    <div className="calendar-page page-content calendar-compact-page">
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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAnchor(today);
              setDayList(today);
            }}
          >
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
              else {
                setView(next);
                setAnchor(dayList);
              }
            }}
          />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button size="sm" className="plan-add-trigger">
                <CalendarPlus size={15} />
                <span>添加计划</span>
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
      <div className="calendar-workspace" data-sidebar-open={sidebarOpen}>
        <aside
          id="plan-day-sidebar"
          className="plan-day-sidebar"
          hidden={!sidebarOpen}
          aria-labelledby="plan-day-sidebar-heading"
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              !event.defaultPrevented &&
              !(event.target as HTMLElement).closest(
                ".plan-agenda-list.is-sorting",
              )
            ) {
              event.stopPropagation();
              closeDaySidebar();
            }
          }}
        >
          {sidebarOpen && (
            <>
              <header className="plan-day-sidebar-header">
                <div>
                  <h2
                    id="plan-day-sidebar-heading"
                    aria-label={`${dayList} 的每日计划`}
                  >
                    <time dateTime={dayList}>{dayHeading}</time>
                    <span>{dayWeekday}</span>
                  </h2>
                  <p>
                    <span>{dayList.slice(0, 4)}年</span>
                    <span>{dayLunar}</span>
                  </p>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="收起每日计划"
                  onClick={closeDaySidebar}
                >
                  <X size={15} />
                </Button>
              </header>
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
                    重复事项 <span>{repeatCount}</span>
                  </button>
                </div>
              </div>
              <div className="plan-sidebar-list-toolbar">
                <span>
                  {agendaTab === "repeat" ? "重复事项" : "待办事项"}
                  <small>{selectedOccurrences.length} 项</small>
                </span>
                <Button
                  className="plan-order-reset"
                  size="sm"
                  variant="ghost"
                  disabled={
                    busy ||
                    loading ||
                    orderSaving ||
                    !dayOrders[dayList]?.length
                  }
                  onClick={() => void saveOrder([])}
                >
                  <RotateCcw size={13} />
                  恢复默认排序
                </Button>
              </div>
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
                    <Hint
                      label={
                        isRepeating(event) ? "删除单日计划安排" : "删除计划"
                      }
                    >
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
                      onClick={() => edit(dayList, event)}
                    >
                      <Pencil size={13} />
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
            </>
          )}
        </aside>
        <div className="plan-calendar" data-view={view}>
          {error && !editor && (
            <ErrorNotice message={error} retry={() => void load()} />
          )}
          {moveNotice && (
            <p className="plan-move-notice" role="status">
              {moveNotice}
            </p>
          )}
          {view === "month" && (
            <div className="plan-weekdays">
              {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(
                (day) => (
                  <span key={day}>{day}</span>
                ),
              )}
            </div>
          )}
          {loading && (
            <span className="calendar-loading" role="status">
              正在读取计划…
            </span>
          )}
          {view === "week" ? (
            <WeekCalendar
              days={weekDays}
              today={today}
              selected={dayList}
              eventsByDay={valuesByDay}
              timezone={timezone}
              onOpenDay={openAgenda}
              onCreate={startCreate}
              onEdit={(day, event) => edit(day, event)}
            />
          ) : (
            <div
              className="plan-month-grid"
              ref={monthGrid}
              style={{
                gridTemplateRows: `repeat(${count / 7}, minmax(0, 1fr))`,
              }}
            >
              {days.map((day) => {
                const values = orderedDay(day);
                const visibleValues = values.filter(
                  (event) => !isRoutine(event),
                );
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
                    data-selected={day === dayList}
                    data-holiday={holidayOn(day)?.kind}
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button, a"))
                        openAgenda(day);
                    }}
                    onDoubleClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button, a"))
                        edit(day);
                    }}
                  >
                    <div className="plan-day-heading">
                      <button
                        className="plan-day-number"
                        aria-label={`${day} 查看计划`}
                        aria-controls="plan-day-sidebar"
                        aria-pressed={day === dayList}
                        onClick={() => openAgenda(day)}
                        onDoubleClick={() => startCreate(day)}
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
                            <b>
                              {holidayOn(day)!.kind === "off" ? "休" : "班"}
                            </b>
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
                                visibleValues.some(
                                  (event) => !isRepeating(event),
                                )
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
      </div>
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
            noValidate
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
                  aria-required="true"
                  aria-invalid={Boolean(form.title && !form.title.trim())}
                  aria-describedby={
                    form.title && !form.title.trim()
                      ? "plan-title-error"
                      : undefined
                  }
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
                {form.title && !form.title.trim() && (
                  <small
                    id="plan-title-error"
                    className="plan-field-error"
                    role="alert"
                  >
                    计划名称不能只包含空格。
                  </small>
                )}
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
                          inputMode="numeric"
                          maxLength={3}
                          aria-invalid={Boolean(intervalError)}
                          aria-describedby={
                            intervalError ? "plan-interval-error" : undefined
                          }
                          value={form.repeat_interval}
                          onChange={(event) => {
                            if (!/^\d*$/.test(event.target.value)) return;
                            setForm({
                              ...form,
                              repeat_interval: event.target.value,
                            });
                          }}
                        />
                        {intervalError && (
                          <small
                            id="plan-interval-error"
                            className="plan-field-error"
                            role="alert"
                          >
                            {intervalError}
                          </small>
                        )}
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
                            {untilError && (
                              <small className="plan-field-error" role="alert">
                                {untilError}
                              </small>
                            )}
                          </div>
                        )}
                        {form.repeat_end_mode === "count" && (
                          <div className="form-field">
                            <Label htmlFor="plan-repeat-count">
                              重复次数（含首次）
                            </Label>
                            <Input
                              id="plan-repeat-count"
                              inputMode="numeric"
                              maxLength={5}
                              aria-required="true"
                              aria-invalid={Boolean(countError)}
                              aria-describedby={
                                countError ? "plan-count-error" : undefined
                              }
                              value={form.repeat_count}
                              onChange={(event) => {
                                if (!/^\d*$/.test(event.target.value)) return;
                                setForm({
                                  ...form,
                                  repeat_count: event.target.value,
                                });
                              }}
                            />
                            {countError && (
                              <small
                                id="plan-count-error"
                                className="plan-field-error"
                                role="alert"
                              >
                                {countError}
                              </small>
                            )}
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
                  {datesError && (
                    <small className="plan-field-error" role="alert">
                      {datesError}
                    </small>
                  )}
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
                  busy || editing?.status === "cancelled" || formInvalid
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
            setAnchor(day);
            setDayList(day);
            setSidebarOpen(true);
            setAgendaTab("repeat");
            setAgendaNotice(
              `已删除单日计划「${cancelling.title}」，可点击恢复按钮恢复。`,
            );
            await Promise.all([
              load(),
              refresh().catch(() => setError("本次已取消，部分列表暂未刷新。")),
            ]);
          } catch (error) {
            setError(errorMessage(error));
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
            await Promise.all([load(), refresh()]).catch(() =>
              setError("计划已删除，部分列表暂未刷新。"),
            );
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      />
    </div>
  );
}
