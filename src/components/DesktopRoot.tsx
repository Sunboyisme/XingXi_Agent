import { DesktopQuickAsk } from "./DesktopQuickAsk";
import { DesktopCapture } from "./DesktopCapture";
import { DesktopPet, DesktopPinned } from "./DesktopCompanions";
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
