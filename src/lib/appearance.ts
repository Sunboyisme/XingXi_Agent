export type Theme = "cream" | "warm-dark";
export const THEME_KEY = "xiaoxi-appearance-theme";
const changedEvent = "xiaoxi-theme-changed";

function savedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "cream" ? "cream" : "warm-dark";
  } catch {
    return "warm-dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "warm-dark");
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "warm-dark" ? "#24211e" : "#f6efe8");
  window.dispatchEvent(new Event(changedEvent));
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "cream"
    ? "cream"
    : "warm-dark";
}

export function setTheme(theme: Theme) {
  // A blocked/full browser store must not prevent using the selected appearance.
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* Keep it for this session. */
  }
  applyTheme(theme);
}

export function subscribeTheme(onChange: () => void) {
  window.addEventListener(changedEvent, onChange);
  return () => window.removeEventListener(changedEvent, onChange);
}

export function initializeAppearance() {
  applyTheme(savedTheme());
  const sync = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) applyTheme(savedTheme());
  };
  window.addEventListener("storage", sync);
  return () => window.removeEventListener("storage", sync);
}
