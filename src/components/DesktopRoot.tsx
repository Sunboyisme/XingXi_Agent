import { lazy } from "react";
const PomodoroNotice = lazy(() =>
  import("./PomodoroNotice").then((m) => ({ default: m.PomodoroNotice })),
);
const DesktopQuickAsk = lazy(() =>
  import("./DesktopQuickAsk").then((m) => ({ default: m.DesktopQuickAsk })),
);
const DesktopCapture = lazy(() =>
  import("./DesktopCapture").then((m) => ({ default: m.DesktopCapture })),
);
const DesktopPet = lazy(() =>
  import("./DesktopCompanions").then((m) => ({ default: m.DesktopPet })),
);
const PomodoroWidget = lazy(() =>
  import("./PomodoroWidget").then((m) => ({ default: m.PomodoroWidget })),
);
const TrayMenu = lazy(() =>
  import("./TrayMenu").then((m) => ({ default: m.TrayMenu })),
);
const DesktopPinned = lazy(() =>
  import("./DesktopPinned").then((m) => ({ default: m.DesktopPinned })),
);
const PinnedContextMenu = lazy(() =>
  import("./PinnedContextMenu").then((m) => ({ default: m.PinnedContextMenu })),
);
const SelectionAssistant = lazy(() =>
  import("./SelectionAssistant").then((m) => ({
    default: m.SelectionAssistant,
  })),
);
import "../styles/desktop-assistant.css";
export function DesktopRoot({ view }: { view: string }) {
  return view === "pomodoro-notice" ? (
    <PomodoroNotice />
  ) : view === "tray-menu" ? (
    <TrayMenu />
  ) : view === "pin-menu" ? (
    <PinnedContextMenu />
  ) : view === "pomodoro-timer" ? (
    <PomodoroWidget />
  ) : view === "selection" ? (
    <SelectionAssistant />
  ) : view === "quick" ? (
    <DesktopQuickAsk />
  ) : view === "capture" ? (
    <DesktopCapture />
  ) : view === "pet" ? (
    <DesktopPet />
  ) : (
    <DesktopPinned />
  );
}
