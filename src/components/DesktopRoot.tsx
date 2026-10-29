import { DesktopQuickAsk } from "./DesktopQuickAsk";
import { DesktopCapture } from "./DesktopCapture";
import {
  DesktopPet,
  DesktopSelection,
  DesktopPinned,
} from "./DesktopCompanions";
import "../styles/desktop-assistant.css";
export function DesktopRoot({ view }: { view: string }) {
  return view === "quick" ? (
    <DesktopQuickAsk />
  ) : view === "capture" ? (
    <DesktopCapture />
  ) : view === "pet" ? (
    <DesktopPet />
  ) : view === "selection" ? (
    <DesktopSelection />
  ) : (
    <DesktopPinned />
  );
}
