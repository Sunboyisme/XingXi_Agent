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
import "./styles/chat-home.css";
import "./styles/chat-polish.css";
import "./styles/memory-settings.css";
import "./styles/version-014.css";

const stopAppearance = initializeAppearance();
import.meta.hot?.dispose(stopAppearance);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
