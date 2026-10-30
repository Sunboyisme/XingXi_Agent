import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  moveNavigationFeature,
  setGeneralPreferences,
  useGeneralPreferences,
  type NavigationFeature,
} from "./generalPreferences";

type Gesture = {
  pointerId: number;
  from: NavigationFeature;
  x: number;
  y: number;
  started: boolean;
  root: HTMLElement;
  original: NavigationFeature[];
  order: NavigationFeature[];
};

/** Tauri's Windows file-drop handler replaces HTML5 DnD. Sorting uses pointers instead. */
export function useNavigationReorder() {
  const { navigationOrder } = useGeneralPreferences();
  const [preview, setPreview] = useState<NavigationFeature[] | null>(null);
  const [dragging, setDragging] = useState<NavigationFeature | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const blockedClick = useRef(false);
  const clearClick = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  function finish(save: boolean) {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    if (active.root.hasPointerCapture?.(active.pointerId))
      active.root.releasePointerCapture(active.pointerId);
    setPreview(null);
    setDragging(null);
    if (
      save &&
      active.started &&
      active.order.some((id, index) => id !== active.original[index])
    ) {
      setGeneralPreferences({ navigationOrder: active.order });
    }
    // The click generated after a drag must not navigate or close the menu.
    if (active.started) {
      blockedClick.current = true;
      clearTimeout(clearClick.current);
      clearClick.current = setTimeout(() => {
        blockedClick.current = false;
      }, 500);
    }
  }
  const cancel = useRef(() => finish(false));
  cancel.current = () => finish(false);
  useEffect(() => {
    const blurred = () => cancel.current();
    // Radix listens for Escape on document capture. Cancel before it dismisses the menu.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current?.started) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel.current();
      }
    };
    window.addEventListener("blur", blurred);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("blur", blurred);
      window.removeEventListener("keydown", escape, true);
      cancel.current();
      clearTimeout(clearClick.current);
    };
  }, []);

  function pointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    blockedClick.current = false;
    clearTimeout(clearClick.current);
    const target = event.target as HTMLElement;
    if (target.closest("[data-navigation-toggle]")) return;
    const item = target.closest<HTMLElement>("[data-navigation-feature]");
    // Portal events also pass through the sidebar. Own only this surface's DOM rows.
    if (!item || !event.currentTarget.contains(item)) return;
    const from = item?.dataset.navigationFeature as
      NavigationFeature | undefined;
    if (!from || !navigationOrder.includes(from)) return;
    gesture.current = {
      pointerId: event.pointerId,
      from,
      x: event.clientX,
      y: event.clientY,
      started: false,
      root: event.currentTarget,
      original: navigationOrder,
      order: navigationOrder,
    };
  }
  function pointerMove(event: ReactPointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    if (!active.started) {
      if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < 6)
        return;
      active.started = true;
      setDragging(active.from);
      active.root.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
    const bounds = active.root.getBoundingClientRect();
    if (event.clientX < bounds.left - 24 || event.clientX > bounds.right + 24)
      return;
    const items = [
      ...active.root.querySelectorAll<HTMLElement>("[data-navigation-feature]"),
    ];
    const target = items.find((item) => {
      const rect = item.getBoundingClientRect();
      return event.clientY >= rect.top && event.clientY <= rect.bottom;
    })?.dataset.navigationFeature as NavigationFeature | undefined;
    if (!target || target === active.from) return;
    active.order = moveNavigationFeature(active.order, active.from, target);
    setPreview(active.order);
  }
  return {
    order: preview || navigationOrder,
    dragging,
    suppressSelect: () =>
      Boolean(gesture.current?.started || blockedClick.current),
    cancel: () => finish(false),
    handlers: {
      onPointerDownCapture: pointerDown,
      onPointerMoveCapture: pointerMove,
      onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => {
        if (gesture.current?.pointerId !== event.pointerId) return;
        if (gesture.current.started) {
          event.preventDefault();
          event.stopPropagation();
        }
        finish(true);
      },
      onPointerCancel: () => finish(false),
      onLostPointerCapture: () => finish(false),
      onDragStartCapture: (event: React.DragEvent<HTMLElement>) =>
        event.preventDefault(),
      onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
        if (blockedClick.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (!gesture.current?.started) blockedClick.current = false;
        if (event.key === "Escape" && gesture.current?.started) {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
          return;
        }
        if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key))
          return;
        if ((event.target as HTMLElement).closest("[data-navigation-toggle]"))
          return;
        const from = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-navigation-feature]",
        )?.dataset.navigationFeature as NavigationFeature | undefined;
        if (!from) return;
        const target =
          navigationOrder[
            navigationOrder.indexOf(from) + (event.key === "ArrowUp" ? -1 : 1)
          ];
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        setGeneralPreferences({
          navigationOrder: moveNavigationFeature(navigationOrder, from, target),
        });
      },
    },
  };
}
