import { useEffect, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { components } from "./api.generated";
import { errorMessage } from "./utils";

export type Pomodoro = components["schemas"]["PomodoroRead"];
export type PomodoroPreferences = components["schemas"]["PomodoroPreferences"];
type Action = components["schemas"]["PomodoroAction"]["action"];
type ClockStore = {
  data: Pomodoro | null;
  connectionError: string;
  actionError: string;
  busy: boolean;
};
let store: ClockStore = {
  data: null,
  connectionError: "",
  actionError: "",
  busy: false,
};
const subscribers = new Set<() => void>();
let stop: (() => void) | undefined;
let reading: Promise<void> | undefined;

function publish(value: Partial<ClockStore>) {
  store = { ...store, ...value };
  subscribers.forEach((callback) => callback());
}
function accept(value: Pomodoro) {
  const old = store.data;
  if (
    old &&
    (value.revision < old.revision ||
      (value.revision === old.revision && value.server_now < old.server_now))
  )
    return;
  publish({ data: value, connectionError: "" });
}
function refreshPomodoro(clearActionError = false) {
  if (clearActionError) publish({ actionError: "" });
  if (!reading)
    reading = api<Pomodoro>("/pomodoro", "GET", undefined, { timeoutMs: 5000 })
      .then(accept)
      .catch((cause) => publish({ connectionError: errorMessage(cause) }))
      .finally(() => {
        reading = undefined;
      });
  return reading;
}
function subscribe(callback: () => void) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    let alive = true;
    const native = isTauri();
    let lastNativeSnapshot = performance.now();
    const unlisten = native
      ? listen<Pomodoro>("pomodoro-snapshot", (event) => {
          lastNativeSnapshot = performance.now();
          if (alive) accept(event.payload);
        })
      : undefined;
    void unlisten?.catch((cause) => {
      if (alive) publish({ connectionError: errorMessage(cause) });
    });
    // Poll only when the native bridge is silent; browser development has no bridge.
    const timer = window.setInterval(
      () => {
        if (!native || performance.now() - lastNativeSnapshot > 5000)
          void refreshPomodoro();
      },
      native ? 5000 : 1000,
    );
    const focus = () => void refreshPomodoro();
    window.addEventListener("focus", focus);
    void refreshPomodoro();
    stop = () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      void unlisten?.then((dispose) => dispose()).catch(() => {});
    };
  }
  return () => {
    subscribers.delete(callback);
    if (!subscribers.size) {
      stop?.();
      stop = undefined;
    }
  };
}
export function usePomodoro() {
  const state = useSyncExternalStore(subscribe, () => store);
  const [, render] = useState(0);
  const running = state.data?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => render((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [running]);
  const remaining = state.data
    ? Math.max(
        0,
        running && state.data.deadline_at !== null
          ? state.data.deadline_at - Date.now() / 1000
          : state.data.remaining_seconds,
      )
    : 0;
  return {
    data: state.data,
    busy: state.busy,
    error: state.actionError || state.connectionError,
    remaining,
    refresh: () => refreshPomodoro(true),
  };
}
async function write(path: string, method: string, body: object) {
  if (store.busy) throw new Error("番茄钟正在保存，请稍候再试。");
  publish({ busy: true, actionError: "" });
  try {
    const value = await api<Pomodoro>(path, method, body, { timeoutMs: 5000 });
    accept(value);
    if (isTauri()) await emit("pomodoro-snapshot", value).catch(() => {});
    return value;
  } catch (cause) {
    await refreshPomodoro();
    publish({ actionError: errorMessage(cause) });
    throw cause;
  } finally {
    publish({ busy: false });
  }
}
export function pomodoroAction(action: Action) {
  if (!store.data && action !== "pause_exit")
    return Promise.reject(new Error("番茄钟尚未读取完成，请稍后重试。"));
  return write("/pomodoro/actions", "POST", {
    action,
    expected_revision: store.data?.revision,
  });
}
export function savePomodoroPreferences(
  preferences: PomodoroPreferences,
  revision = store.data?.revision,
) {
  return write("/pomodoro/settings", "PATCH", {
    ...preferences,
    expected_revision: revision,
  });
}
export function formatCountdown(seconds: number) {
  const value = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}
const phaseLabels = {
  idle: ["准备开始", "待开始"],
  focus: ["专注中", "专注"],
  break: ["休息中", "休息"],
  waiting_break: ["专注完成", "待休息"],
  waiting_focus: ["准备下一轮", "待开始"],
} as const;
export function pomodoroStatus(data: Pomodoro, compact = false) {
  if (data.status === "paused") return "已暂停";
  return phaseLabels[data.phase][compact ? 1 : 0];
}
export function primaryPomodoroAction(data: Pomodoro): {
  action: Action;
  label: string;
} {
  if (data.status === "paused") return { action: "resume", label: "继续" };
  if (data.status === "running") return { action: "pause", label: "暂停" };
  if (data.phase === "waiting_break")
    return { action: "start_break", label: "开始休息" };
  return {
    action: "start_focus",
    label: data.phase === "waiting_focus" ? "开始下一轮" : "开始专注",
  };
}
