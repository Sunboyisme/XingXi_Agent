import { useEffect, useRef, useState, type FocusEvent } from "react";

/** Interactive theme popovers open on hover or focus without taking text-input focus. */
export function useHoverPopover(disabled = false) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const suppressFocus = useRef(false);
  function cancelClose() {
    clearTimeout(closeTimer.current);
  }
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  function contains(target: EventTarget | null) {
    return (
      target instanceof Node &&
      (trigger.current?.contains(target) || content.current?.contains(target))
    );
  }
  function show() {
    cancelClose();
    if (!disabled) setOpen(true);
  }
  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!contains(document.activeElement)) setOpen(false);
    }, 180);
  }
  function onFocus() {
    if (!suppressFocus.current) show();
  }
  function onBlur(event: FocusEvent<HTMLElement>) {
    if (!contains(event.relatedTarget)) {
      suppressFocus.current = false;
      cancelClose();
      setOpen(false);
    }
  }
  function closeAndFocus() {
    cancelClose();
    suppressFocus.current = true;
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return {
    open: open && !disabled,
    trigger,
    content,
    show,
    scheduleClose,
    cancelClose,
    onFocus,
    onBlur,
    closeAndFocus,
    onOpenChange: (value: boolean) => {
      cancelClose();
      setOpen(value && !disabled);
    },
  };
}

export type HoverPopover = ReturnType<typeof useHoverPopover>;
