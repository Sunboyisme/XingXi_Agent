import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initializeAppearance } from "./lib/appearance";
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

const stopAppearance = initializeAppearance();
import.meta.hot?.dispose(stopAppearance);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
