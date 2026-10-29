import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type RefObject,
} from "react";

/** Interactive theme popovers open on hover or focus without taking text-input focus. */
export function useHoverPopover(
  disabled = false,
  relatedContent: RefObject<HTMLElement | null>[] = [],
) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const suppressFocus = useRef(false);
  const keyboardInteraction = useRef(false);
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
      (trigger.current?.contains(target) ||
        content.current?.contains(target) ||
        relatedContent.some((element) => element.current?.contains(target)))
    );
  }
  function show() {
    cancelClose();
    if (!disabled) setOpen(true);
  }
  function showOnPointer() {
    keyboardInteraction.current = false;
    show();
  }
  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!keyboardInteraction.current || !contains(document.activeElement))
        setOpen(false);
    }, 180);
  }
  function onFocus() {
    keyboardInteraction.current = true;
    if (!suppressFocus.current) show();
  }
  function onBlur(event: FocusEvent<HTMLElement>) {
    if (!contains(event.relatedTarget)) {
      suppressFocus.current = false;
      keyboardInteraction.current = false;
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
    showOnPointer,
    onKeyboardInteraction: () => {
      keyboardInteraction.current = true;
    },
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
