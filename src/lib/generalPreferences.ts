import { useSyncExternalStore, type KeyboardEvent } from "react";

const navigationFeatures = [
  "projects",
  "learning",
  "plans",
  "knowledge",
  "common-texts",
] as const;
export type NavigationFeature = (typeof navigationFeatures)[number];

type GeneralPreferences = {
  inputSuggestions: boolean;
  hiddenNavigation: NavigationFeature[];
  navigationOrder: NavigationFeature[];
};
const storageKey = "xiaoxi-general-preferences-v1";
const changedEvent = "xiaoxi-general-preferences-changed";
const defaults: GeneralPreferences = {
  inputSuggestions: true,
  hiddenNavigation: [],
  navigationOrder: [...navigationFeatures],
};
export function normalizeNavigationOrder(value: unknown): NavigationFeature[] {
  const saved = Array.isArray(value)
    ? value.filter((id): id is NavigationFeature =>
        navigationFeatures.includes(id),
      )
    : [];
  return [...new Set([...saved, ...navigationFeatures])];
}
export function moveNavigationFeature(
  order: NavigationFeature[],
  from: NavigationFeature,
  to: NavigationFeature,
) {
  const next = normalizeNavigationOrder(order);
  const start = next.indexOf(from),
    end = next.indexOf(to);
  if (start !== end) {
    next.splice(start, 1);
    next.splice(end, 0, from);
  }
  return next;
}
function readPreferences(): GeneralPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return {
      inputSuggestions: saved?.inputSuggestions !== false,
      navigationOrder: normalizeNavigationOrder(saved?.navigationOrder),
      hiddenNavigation: Array.isArray(saved?.hiddenNavigation)
        ? navigationFeatures.filter((id) => saved.hiddenNavigation.includes(id))
        : saved?.navigationCollapsed === true
          ? [...navigationFeatures]
          : [],
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
export function isSendShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229
  )
    return false;
  return true;
}
