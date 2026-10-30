import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const DesktopRoot = lazy(() =>
  import("./DesktopRoot").then((module) => ({ default: module.DesktopRoot })),
);
const activations: Record<string, string> = {
  quick: "desktop-shown",
  "pomodoro-notice": "pomodoro-notice-open",
  capture: "capture-ready",
  selection: "selection-snapshot",
};

/** Hidden native shells stay light until their first actual use. Native queues
 * and snapshots retain requests while a surface's module is loading. */
export function DesktopGate({ view }: { view: string }) {
  const [ready, setReady] = useState(!activations[view]);
  useEffect(() => {
    if (!activations[view]) return;
    let alive = true;
    const activate = () => {
      if (alive) setReady(true);
    };
    const stop = listen(activations[view], activate);
    const hidden =
      view === "pomodoro-notice"
        ? listen("pomodoro-notice-hidden", () => {
            if (alive) setReady(false);
          })
        : undefined;
    void stop
      .then(async () => {
        if (await getCurrentWindow().isVisible()) {
          activate();
          return;
        }
        if (view === "quick" && (await invoke<string>("desktop_ask_session")))
          activate();
        if (view === "capture") {
          await invoke("capture_get");
          activate();
        }
        if (
          view === "selection" &&
          (await invoke<{ id: number }>("selection_snapshot")).id
        )
          activate();
      })
      .catch(() => {});
    return () => {
      alive = false;
      void stop.then((dispose) => dispose()).catch(() => {});
      void hidden?.then((dispose) => dispose()).catch(() => {});
    };
  }, [view]);
  return ready ? (
    <Suspense fallback={null}>
      <DesktopRoot view={view} />
    </Suspense>
  ) : null;
}
