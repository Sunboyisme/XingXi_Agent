import { DesktopQuickAsk } from "./DesktopQuickAsk";
import { DesktopCapture } from "./DesktopCapture";
import { DesktopPet } from "./DesktopCompanions";
import { PomodoroWidget } from "./PomodoroWidget";
import { TrayMenu } from "./TrayMenu";
import { DesktopPinned } from "./DesktopPinned";
import { PinnedContextMenu } from "./PinnedContextMenu";
import { SelectionAssistant } from "./SelectionAssistant";
import "../styles/desktop-assistant.css";
export function DesktopRoot({ view }: { view: string }) {
  return view === "tray-menu" ? <TrayMenu /> : view === "pin-menu" ? <PinnedContextMenu /> : view === "pomodoro-timer" ? <PomodoroWidget /> : view === "selection" ? (
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
