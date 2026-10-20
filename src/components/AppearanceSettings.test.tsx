import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AppearanceSettings } from "./AppearanceSettings";
import { initializeAppearance, THEME_KEY } from "@/lib/appearance";

let stop = () => {};
afterEach(() => {
  cleanup();
  stop();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove("dark");
});

test("theme choice persists and another window's preference updates the current view", () => {
  stop = initializeAppearance();
  const view = render(<AppearanceSettings />);
  expect(document.documentElement.dataset.theme).toBe("warm-dark");
  const light = screen.getByRole("radio", { name: "奶油杏 · 浅色" });
  fireEvent.click(light);
  expect(localStorage.getItem(THEME_KEY)).toBe("cream");
  expect(document.documentElement.dataset.theme).toBe("cream");
  const dark = screen.getByRole("radio", { name: "暖灰棕 · 深色" });
  fireEvent.click(dark);
  expect(localStorage.getItem(THEME_KEY)).toBe("warm-dark");
  expect(document.documentElement.dataset.theme).toBe("warm-dark");
  view.unmount();
  stop();
  stop = initializeAppearance();
  render(<AppearanceSettings />);
  expect(
    (screen.getByRole("radio", { name: "暖灰棕 · 深色" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  act(() => {
    localStorage.setItem(THEME_KEY, "cream");
    window.dispatchEvent(
      new StorageEvent("storage", { key: THEME_KEY, newValue: "cream" }),
    );
  });
  expect(
    (screen.getByRole("radio", { name: "奶油杏 · 浅色" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

test("an invalid preference or blocked storage cannot make appearance settings unusable", () => {
  localStorage.setItem(THEME_KEY, "unknown-theme");
  stop = initializeAppearance();
  expect(document.documentElement.dataset.theme).toBe("warm-dark");
  render(<AppearanceSettings />);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  fireEvent.click(screen.getByRole("radio", { name: "暖灰棕 · 深色" }));
  expect(document.documentElement.dataset.theme).toBe("warm-dark");
  expect(
    (screen.getByRole("radio", { name: "暖灰棕 · 深色" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});
