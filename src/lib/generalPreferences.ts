import { useSyncExternalStore, type KeyboardEvent } from "react";

type GeneralPreferences = {
  sendShortcut: "enter" | "mod-enter";
  inputSuggestions: boolean;
  navigationCollapsed: boolean;
};
const storageKey = "xiaoxi-general-preferences-v1";
const changedEvent = "xiaoxi-general-preferences-changed";
const defaults: GeneralPreferences = {
  sendShortcut: "enter",
  inputSuggestions: true,
  navigationCollapsed: false,
};
function readPreferences(): GeneralPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return {
      sendShortcut: saved?.sendShortcut === "mod-enter" ? "mod-enter" : "enter",
      inputSuggestions: saved?.inputSuggestions !== false,
      navigationCollapsed: saved?.navigationCollapsed === true,
    };
  } catch {
    return defaults;
  }
}
let snapshot = readPreferences();
function subscribe(onChange: () => void) {
  const sync = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) {
      snapshot = readPreferences();
      onChange();
    }
  };
  window.addEventListener(changedEvent, onChange);
  window.addEventListener("storage", sync);
  return () => {
    window.removeEventListener(changedEvent, onChange);
    window.removeEventListener("storage", sync);
  };
}
export function useGeneralPreferences() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
export function setGeneralPreferences(value: Partial<GeneralPreferences>) {
  snapshot = { ...snapshot, ...value };
  try {
    localStorage.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    // Keep preferences usable for this session if storage is unavailable.
  }
  window.dispatchEvent(new Event(changedEvent));
}
export function isSendShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  shortcut: GeneralPreferences["sendShortcut"],
) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.altKey ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229
  )
    return false;
  return shortcut === "mod-enter"
    ? event.ctrlKey || event.metaKey
    : !event.ctrlKey && !event.metaKey;
}
