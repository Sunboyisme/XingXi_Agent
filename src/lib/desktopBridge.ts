import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
/** Read the focused webview at the moment its shortcut is requested, never reuse another window's selection. */
export function initializeDesktopSelectionBridge() {
  if (!isTauri()) return () => {};
  const selectedText = () => {
    const node = document.activeElement;
    if (
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement
    ) {
      if (node instanceof HTMLInputElement && node.type === "password")
        return "";
      try {
        return node.value.slice(
          node.selectionStart ?? 0,
          node.selectionEnd ?? 0,
        );
      } catch {
        return "";
      }
    }
    return window.getSelection()?.toString() || "";
  };
  let stopped = false;
  const listener = listen<{ requestId: string }>(
    "desktop-selection-request",
    (event) => {
      if (!stopped)
        void invoke("desktop_selection_offer", {
          requestId: event.payload.requestId,
          text: selectedText(),
        }).catch(() => {});
    },
  );
  return () => {
    stopped = true;
    void listener.then((unlisten) => unlisten());
  };
}
