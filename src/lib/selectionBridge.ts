import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Capture only in direct response to the native request; no persistent selection cache. */
export function initializeSelectionBridge() {
  if (!isTauri()) return () => {};
  let active = true;
  const stop = listen<number>("selection-read", (event) => {
    if (!active || !document.hasFocus()) return;
    const element = document.activeElement;
    let text = "";
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      if (!(
        element instanceof HTMLInputElement && element.type === "password"
      )) {
        const start = element.selectionStart,
          end = element.selectionEnd;
        if (start !== null && end !== null && end > start)
          text = element.value.slice(start, Math.min(end, start + 100001));
      }
    } else text = window.getSelection()?.toString().slice(0, 100001) || "";
    void invoke("selection_dom_reply", { id: event.payload, text }).catch(
      () => {},
    );
  });
  return () => {
    active = false;
    void stop.then((unlisten) => unlisten()).catch(() => {});
  };
}
