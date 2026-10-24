import { useRef } from "react";

type AutoFocusHandlers = {
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
};

// Controlled dialogs may open without a Radix trigger. Restore their external
// opener too, unless the caller handles focus or the opener has been removed.
export function useDialogFocus(handlers: AutoFocusHandlers): AutoFocusHandlers {
  const returnFocus = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event) {
      returnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      handlers.onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus(event) {
      handlers.onCloseAutoFocus?.(event);
      if (!event.defaultPrevented && returnFocus.current?.isConnected) {
        event.preventDefault();
        returnFocus.current.focus();
      }
    },
  };
}
