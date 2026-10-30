import { DesktopQuickAsk } from "./DesktopQuickAsk";
import { DesktopCapture } from "./DesktopCapture";
import { DesktopPet } from "./DesktopCompanions";
import { DesktopPinned } from "./DesktopPinned";
import { SelectionAssistant } from "./SelectionAssistant";
import "../styles/desktop-assistant.css";
export function DesktopRoot({ view }: { view: string }) {
  return view === "selection" ? (
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
