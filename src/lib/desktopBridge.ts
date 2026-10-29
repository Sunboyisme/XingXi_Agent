import { isTauri, invoke } from "@tauri-apps/api/core";
export function initializeDesktopSelectionBridge() {
  if (!isTauri()) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void invoke("desktop_selection_offer", {
        text: window.getSelection()?.toString() || "",
      }).catch(() => {});
    }, 40);
  };
  document.addEventListener("selectionchange", update);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("selectionchange", update);
  };
}
