type Theme = "cream" | "warm-dark";
export type ThemePreference = Theme | "system";
export const THEME_KEY = "xiaoxi-appearance-theme";
const changedEvent = "xiaoxi-theme-changed";

function savedTheme(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "cream" || value === "system" ? value : "warm-dark";
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

export function currentThemePreference(): ThemePreference {
  const value = document.documentElement.dataset.themePreference;
  return value === "cream" || value === "system" ? value : "warm-dark";
}

function applyPreference(preference: ThemePreference) {
  document.documentElement.dataset.themePreference = preference;
  applyTheme(preference === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "warm-dark" : "cream")
    : preference);
}

export function setTheme(theme: ThemePreference) {
  // A blocked/full browser store must not prevent using the selected appearance.
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* Keep it for this session. */
  }
  applyPreference(theme);
}

export function subscribeTheme(onChange: () => void) {
  window.addEventListener(changedEvent, onChange);
  return () => window.removeEventListener(changedEvent, onChange);
}

export function initializeAppearance() {
  applyPreference(savedTheme());
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (currentThemePreference() === "system") applyPreference("system");
  };
  media?.addEventListener("change", onSystemChange);
  const sync = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) applyPreference(savedTheme());
  };
  window.addEventListener("storage", sync);
  return () => {
    window.removeEventListener("storage", sync);
    media?.removeEventListener("change", onSystemChange);
  };
}
