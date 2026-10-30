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
  page?:
    "pomodoro" | "current" | "plans" | "notifications" | "common-texts" | null;
};

export function subscribeDesktopNavigation(
  accept: (request: DesktopNavigation) => void,
  fail: (cause: unknown) => void,
) {
  let alive = true;
  let newest = 0;
  const receive = (request: DesktopNavigation) => {
    if (!alive || !Number.isSafeInteger(request.id) || request.id <= newest)
      return;
    newest = request.id;
    latestNavigationId = request.id;
    try {
      accept(request);
      void invoke("desktop_navigation_ack", { id: request.id }).catch(
        (cause) => {
          if (alive) fail(cause);
        },
      );
    } catch (cause) {
      fail(cause);
    }
  };
  const stop = listen<DesktopNavigation>("desktop-navigate", (event) =>
    receive(event.payload),
  );
  void stop
    .then(async () => {
      if (!alive) return;
      const pending = await invoke<DesktopNavigation | null>(
        "desktop_navigation_pending",
      );
      if (pending) receive(pending);
    })
    .catch((cause) => {
      if (alive) fail(cause);
    });
  return () => {
    alive = false;
    void stop.then((dispose) => dispose()).catch(() => {});
  };
}
