import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from "react";

/** Internal sorting uses pointers: Windows native file drop owns HTML drag events. */
export function usePointerReorder(
  ids: string[],
  commit: (ids: string[]) => void | Promise<void>,
  disabled = false,
) {
  const [preview, setPreview] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string>();
  const latest = useRef({ ids, commit, disabled });
  latest.current = { ids, commit, disabled };
  const gesture = useRef<{
    id: string;
    pointer: number;
    y: number;
    started: boolean;
    order: string[];
    target: HTMLElement;
    root: HTMLElement;
  } | null>(null);
  function finish(save: boolean) {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    if (g.target.hasPointerCapture(g.pointer))
      g.target.releasePointerCapture(g.pointer);
    setPreview(null);
    setDragging(undefined);
    if (save && g.started && g.order.join() !== latest.current.ids.join())
      void latest.current.commit(g.order);
  }
  useEffect(() => {
    const blur = () => finish(false);
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(false);
      }
    };
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", key, true);
      finish(false);
    };
  }, []);
  const signature = ids.join();
  useEffect(() => {
    finish(false);
  }, [signature, disabled]);
  function handle(id: string) {
    return {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (latest.current.disabled || event.button !== 0 || !event.isPrimary)
          return;
        const root = event.currentTarget.closest<HTMLElement>(
          "[data-reorder-list]",
        );
        if (!root) return;
        event.preventDefault();
        event.currentTarget.focus();
        gesture.current = {
          id,
          pointer: event.pointerId,
          y: event.clientY,
          started: false,
          order: [...latest.current.ids],
          target: event.currentTarget,
          root,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const g = gesture.current;
        if (!g || g.pointer !== event.pointerId) return;
        if (!g.started && Math.abs(event.clientY - g.y) < 5) return;
        g.started = true;
        setDragging(g.id);
        event.preventDefault();
        const rootBounds = g.root.getBoundingClientRect();
        g.root.scrollTop +=
          event.clientY < rootBounds.top + 24
            ? -12
            : event.clientY > rootBounds.bottom - 24
              ? 12
              : 0;
        const rows = [
          ...g.root.querySelectorAll<HTMLElement>("[data-sort-id]"),
        ].filter((row) => row.closest("[data-reorder-list]") === g.root);
        const at = rows.reduce(
          (best, row) => {
            const box = row.getBoundingClientRect();
            const distance = Math.abs(event.clientY - box.top - box.height / 2);
            return distance < best.distance
              ? { id: row.dataset.sortId!, distance }
              : best;
          },
          { id: g.id, distance: Infinity },
        ).id;
        if (at !== g.id) {
          const next = [...g.order],
            from = next.indexOf(g.id),
            to = next.indexOf(at);
          if (from >= 0 && to >= 0) {
            next.splice(from, 1);
            next.splice(to, 0, g.id);
            g.order = next;
            setPreview(next);
          }
        }
      },
      onPointerUp(event: PointerEvent<HTMLElement>) {
        if (gesture.current?.pointer === event.pointerId) finish(true);
      },
      onPointerCancel() {
        finish(false);
      },
      onLostPointerCapture() {
        finish(false);
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (
          latest.current.disabled ||
          !["ArrowUp", "ArrowDown"].includes(event.key)
        )
          return;
        event.preventDefault();
        const next = [...latest.current.ids],
          from = next.indexOf(id),
          to = from + (event.key === "ArrowUp" ? -1 : 1);
        if (from < 0 || to < 0 || to >= next.length) return;
        [next[from], next[to]] = [next[to], next[from]];
        void latest.current.commit(next);
      },
    };
  }
  return { order: preview || ids, dragging, handle };
}
