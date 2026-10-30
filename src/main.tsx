import React from "react";
import ReactDOM from "react-dom/client";
import { lazy, Suspense } from "react";
const App = lazy(() => import("./App").then((m) => ({ default: m.App })));
import { initializeAppearance } from "./lib/appearance";
import { initializeSelectionBridge } from "./lib/selectionBridge";
import "./style.css";
import "./styles/cream.css";
import "./styles/workspace.css";
import "./styles/version-013.css";
import "./styles/improvements-013.css";
import "./styles/plans.css";
import "./styles/appearance.css";
import "./styles/chat-polish.css";
import "./styles/memory-settings.css";
import "./styles/version-014.css";
import "./styles/complex-tasks.css";
import "./styles/version-016.css";
import "./styles/feedback-016.css";
import "./styles/version-017.css";
import "./styles/new-chat.css";
import "./styles/version-018.css";
import "./styles/feedback-018.css";
import "./styles/screenshot-feedback.css";
import "./styles/model-picker.css";
import "./styles/composer-action.css";
import "./styles/calendar-compact.css";
import "./styles/feature-typography.css";

const stopAppearance = initializeAppearance();
const stopSelectionBridge = initializeSelectionBridge();
import.meta.hot?.dispose(stopSelectionBridge);
import.meta.hot?.dispose(stopAppearance);
const desktopView = new URLSearchParams(location.search).get("view") || "";
const isDesktopSurface =
  [
    "quick",
    "capture",
    "pet",
    "selection",
    "pomodoro-timer",
    "pomodoro-notice",
    "tray-menu",
  ].includes(desktopView) || desktopView.startsWith("pin-");
if (isDesktopSurface) document.documentElement.dataset.desktop = desktopView;
const DesktopRoot = lazy(() =>
  import("./components/DesktopGate").then((m) => ({ default: m.DesktopGate })),
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isDesktopSurface ? (
      <Suspense fallback={null}>
        <DesktopRoot view={desktopView} />
      </Suspense>
    ) : (
      <Suspense fallback={null}>
        <App />
      </Suspense>
    )}
  </React.StrictMode>,
);
