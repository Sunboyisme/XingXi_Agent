import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { GripVertical } from "lucide-react";
import type { CalendarEvent } from "@/lib/api";
import { occurrenceOrderKey } from "@/lib/calendarMonth";

type Gesture = {
  key: string;
  keys: string[];
  pointerId?: number;
  from: number;
  to: number;
  dy: number;
  startY: number;
  y: number;
  scrollTop: number;
  keyboard: boolean;
  rows: { top: number; height: number }[];
};

// Keep the DOM order stable while dragging: the complete row follows the
// pointer and its neighbours move into the vacated space. Persist only on drop.
export function PlanAgendaList({
  events,
  disabled,
  onReorder,
  children,
  empty,
}: {
  events: CalendarEvent[];
  disabled: boolean;
  onReorder: (keys: string[]) => Promise<boolean>;
  children: (event: CalendarEvent) => ReactNode;
  empty: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const returnFocus = useRef("");
  const [active, setActive] = useState<Gesture | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const instructions = useId();
  const signature = events.map(occurrenceOrderKey).join("|");
  useEffect(() => {
    if (
      gesture.current &&
      (disabled || gesture.current.keys.join("|") !== signature)
    ) {
      gesture.current = null;
      setActive(null);
      setAnnouncement("事项已更新，已取消本次排序。");
    }
  }, [disabled, signature]);
  const values = pending
    ? [...events].sort(
        (a, b) =>
          pending.indexOf(occurrenceOrderKey(a)) -
          pending.indexOf(occurrenceOrderKey(b)),
      )
    : events;

  const updatePointer = useCallback(() => {
    const current = gesture.current;
    if (!current || current.keyboard || !list.current) return;
    const requested =
      current.y - current.startY + list.current.scrollTop - current.scrollTop;
    const source = current.rows[current.from];
    const first = current.rows[0];
    const last = current.rows[current.rows.length - 1];
    // Keep transforms inside the original list height so edge scrolling cannot
    // grow the scroll range by dragging the last row beyond the bottom.
    const dy = Math.max(
      first.top - source.top,
      Math.min(last.top + last.height - source.top - source.height, requested),
    );
    const center = source.top + source.height / 2 + requested;
    let to = 0;
    for (let index = 0; index < current.rows.length; index++) {
      if (index === current.from) continue;
      const row = current.rows[index];
      if (center > row.top + row.height / 2) to++;
    }
    if (dy !== current.dy || to !== current.to) {
      gesture.current = { ...current, dy, to };
      setActive(gesture.current);
    }
  }, []);

  const pointerSorting = Boolean(active && !active.keyboard);
  useEffect(() => {
    if (!pointerSorting) return;
    let frame = 0;
    let previous = 0;
    function scroll(now: number) {
      const current = gesture.current;
      const element = list.current;
      if (!current || current.keyboard || !element) return;
      const bounds = element.getBoundingClientRect();
      const edge = Math.min(48, bounds.height / 4);
      const speed =
        current.y < bounds.top + edge
          ? -Math.min(1, (bounds.top + edge - current.y) / edge)
          : current.y > bounds.bottom - edge
            ? Math.min(1, (current.y - bounds.bottom + edge) / edge)
            : 0;
      const elapsed = previous ? Math.min(32, now - previous) : 16;
      previous = now;
      if (speed) {
        element.scrollTop += speed * elapsed * 0.45;
        updatePointer();
      }
      frame = requestAnimationFrame(scroll);
    }
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [pointerSorting, updatePointer]);

  useEffect(() => {
    if (pending || disabled || !returnFocus.current) return;
    const key = returnFocus.current;
    returnFocus.current = "";
    const row = [
      ...(list.current?.querySelectorAll<HTMLElement>(".plan-agenda-row") ||
        []),
    ].find((element) => element.dataset.orderKey === key);
    row
      ?.querySelector<HTMLButtonElement>(".plan-order-handle")
      ?.focus({ preventScroll: true });
  }, [pending, disabled]);

  function begin(key: string, keyboard: boolean, y = 0) {
    if (disabled || pending || gesture.current || !list.current) return;
    const nodes = [
      ...list.current.querySelectorAll<HTMLElement>(".plan-agenda-row"),
    ];
    const from = values.findIndex((event) => occurrenceOrderKey(event) === key);
    if (from < 0 || nodes.length !== values.length) return;
    const bounds = list.current.getBoundingClientRect();
    const rows = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top - bounds.top + list.current!.scrollTop,
        height: rect.height,
      };
    });
    gesture.current = {
      key,
      keys: values.map(occurrenceOrderKey),
      from,
      to: from,
      dy: 0,
      startY: y,
      y,
      scrollTop: list.current.scrollTop,
      keyboard,
      rows,
    };
    setActive(gesture.current);
    setAnnouncement(
      `已拿起 ${values[from].title}，第 ${from + 1} 项，共 ${values.length} 项。`,
    );
  }

  async function finish(commit: boolean) {
    const current = gesture.current;
    gesture.current = null;
    setActive(null);
    if (!current) return;
    if (!commit || current.from === current.to) {
      setAnnouncement(commit ? "顺序未变。" : "已取消排序。");
      return;
    }
    const keys = [...current.keys];
    keys.splice(current.to, 0, keys.splice(current.from, 1)[0]);
    if (current.keyboard) returnFocus.current = current.key;
    setPending(keys);
    try {
      const saved = await onReorder(keys);
      setAnnouncement(
        saved
          ? `顺序已保存，移到第 ${current.to + 1} 项。`
          : "保存失败，已恢复原顺序。",
      );
    } finally {
      setPending(null);
    }
  }

  function keyboardMove(event: KeyboardEvent<HTMLButtonElement>, key: string) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (gesture.current?.key === key) void finish(true);
      else begin(key, true);
      return;
    }
    const current = gesture.current;
    if (!current || current.key !== key) return;
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      void finish(false);
      return;
    }
    if (
      !current.keyboard ||
      !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
    )
      return;
    event.preventDefault();
    const to =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? values.length - 1
          : Math.max(
              0,
              Math.min(
                values.length - 1,
                current.to + (event.key === "ArrowUp" ? -1 : 1),
              ),
            );
    const target = current.rows[to];
    const source = current.rows[current.from];
    const dy =
      to > current.from
        ? target.top + target.height - source.top - source.height
        : target.top - source.top;
    gesture.current = { ...current, to, dy };
    setActive(gesture.current);
    const element = list.current!;
    if (source.top + dy < element.scrollTop)
      element.scrollTop = source.top + dy;
    else if (
      source.top + dy + source.height >
      element.scrollTop + element.clientHeight
    )
      element.scrollTop =
        source.top + dy + source.height - element.clientHeight;
    setAnnouncement(`第 ${to + 1} 项，共 ${values.length} 项。`);
  }

  function pointerStart(event: PointerEvent<HTMLButtonElement>, key: string) {
    if (event.button !== 0 || disabled || pending) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    begin(key, false, event.clientY);
    if (gesture.current) {
      gesture.current.pointerId = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  return (
    <>
      <p className="sr-only" id={instructions}>
        拖动手柄调整顺序。键盘按空格或回车拿起，上下方向键移动，回车保存，Esc
        取消。
      </p>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <div
        className={`plan-agenda-list ${active ? "is-sorting" : ""}`}
        ref={list}
        role="list"
        aria-label="当天事项"
      >
        {values.map((event, index) => {
          const key = occurrenceOrderKey(event);
          const moving = active?.key === key;
          let offset = 0;
          if (active) {
            const { from, to, rows } = active;
            if (moving) offset = active.dy;
            else if (from < index && index <= to)
              offset = rows[from].top - rows[from + 1].top;
            else if (to <= index && index < from)
              offset =
                rows[from].top +
                rows[from].height -
                rows[from - 1].top -
                rows[from - 1].height;
          }
          return (
            <div
              className={`plan-agenda-row ${moving ? "is-dragging" : ""}`}
              key={key}
              role="listitem"
              data-occurrence={event.occurrence_start || event.start}
              data-order-key={key}
              style={{
                transform: offset ? `translateY(${offset}px)` : undefined,
              }}
            >
              <button
                type="button"
                className="plan-order-handle"
                disabled={disabled || Boolean(pending)}
                aria-label={`排序 ${event.title}，第 ${(moving ? active!.to : index) + 1} 项，共 ${values.length} 项`}
                aria-describedby={instructions}
                onPointerDown={(pointer) => pointerStart(pointer, key)}
                onPointerMove={(pointer) => {
                  if (
                    !gesture.current ||
                    gesture.current.pointerId !== pointer.pointerId
                  )
                    return;
                  gesture.current.y = pointer.clientY;
                  updatePointer();
                }}
                onPointerUp={(pointer) => {
                  if (gesture.current?.pointerId === pointer.pointerId)
                    void finish(true);
                }}
                onPointerCancel={(pointer) => {
                  if (gesture.current?.pointerId === pointer.pointerId)
                    void finish(false);
                }}
                onLostPointerCapture={(pointer) => {
                  if (gesture.current?.pointerId === pointer.pointerId)
                    void finish(false);
                }}
                onKeyDown={(keyboard) => keyboardMove(keyboard, key)}
                onBlur={() => {
                  if (gesture.current?.keyboard) void finish(false);
                }}
              >
                <GripVertical size={16} />
              </button>
              {children(event)}
            </div>
          );
        })}
        {!values.length && empty}
      </div>
    </>
  );
}
