import { useEffect, type RefObject } from "react";
import { markDesktopTaskRead } from "./desktopTaskInbox";

/** Read receipts follow content that has loaded in a focused, visible conversation. */
export function useDesktopTaskRead(conversationId: string | null, ready: boolean, surface: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!conversationId || !ready) return;
    const read = () => {
      if (!document.hidden && document.hasFocus() && surface.current?.getClientRects().length) markDesktopTaskRead({ conversationId });
    };
    read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [conversationId, ready, surface]);
}
