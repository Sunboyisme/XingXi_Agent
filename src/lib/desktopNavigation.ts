import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let latestNavigationId = 0;
export function desktopNavigationId() {
  return latestNavigationId;
}

export type DesktopNavigation = {
  id: number;
  conversationId?: string | null;
  settings?: boolean;
  settingsTab?: string | null;
  newChat?: boolean;
  commonTextAssetId?: string;
  page?:
    "pomodoro" | "current" | "plans" | "notifications" | "common-texts" | null;
};

export function subscribeDesktopNavigation(
  accept: (request: DesktopNavigation) => void,
  fail: (cause: unknown) => void,
) {
  let alive = true;
  let newest = 0;
  let reading = false;
  const acknowledging = new Set<number>();
  async function acknowledge(request: DesktopNavigation) {
    if (!alive || acknowledging.has(request.id)) return;
    acknowledging.add(request.id);
    try {
      const next = await invoke<DesktopNavigation | null>(
        "desktop_navigation_ack",
        { id: request.id },
      );
      if (alive && next) receive(next);
    } catch (cause) {
      if (alive) fail(cause);
    } finally {
      acknowledging.delete(request.id);
    }
  }
  function receive(request: DesktopNavigation) {
    if (
      !alive ||
      !Number.isSafeInteger(request.id) ||
      request.id <= 0 ||
      request.id < newest
    )
      return;
    if (request.id === newest) {
      void acknowledge(request);
      return;
    }
    try {
      accept(request);
      newest = request.id;
      latestNavigationId = request.id;
      void acknowledge(request);
    } catch (cause) {
      fail(cause);
    }
  }
  async function readPending() {
    if (!alive || reading) return;
    reading = true;
    try {
      const pending = await invoke<DesktopNavigation | null>(
        "desktop_navigation_pending",
      );
      if (alive && pending) receive(pending);
    } catch (cause) {
      if (alive) fail(cause);
    } finally {
      reading = false;
    }
  }
  const focus = () => {
    void readPending();
  };
  window.addEventListener("focus", focus);
  const stop = listen<DesktopNavigation>("desktop-navigate", (event) =>
    receive(event.payload),
  );
  void stop.then(readPending).catch((cause) => {
    if (alive) {
      fail(cause);
      void readPending();
    }
  });
  return () => {
    alive = false;
    window.removeEventListener("focus", focus);
    void stop.then((dispose) => dispose()).catch(() => {});
  };
}
