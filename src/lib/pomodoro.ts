import { useEffect, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { components } from "./api.generated";
import { errorMessage } from "./utils";

export type Pomodoro = components["schemas"]["PomodoroRead"];
export type PomodoroPreferences = components["schemas"]["PomodoroPreferences"];
export type PomodoroPreset = components["schemas"]["PomodoroPreset"];
type Action = components["schemas"]["PomodoroAction"]["action"];
type ClockStore = {
  data: Pomodoro | null;
  error: string;
  busy: boolean;
};
let store: ClockStore = { data: null, error: "", busy: false };
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
  publish({ data: value, error: "" });
}
export function refreshPomodoro() {
  if (!reading)
    reading = api<Pomodoro>("/pomodoro", "GET", undefined, { timeoutMs: 5000 })
      .then(accept)
      .catch((cause) => publish({ error: errorMessage(cause) }))
      .finally(() => {
        reading = undefined;
      });
  return reading;
}
function subscribe(callback: () => void) {
  subscribers.add(callback);
  if (subscribers.size === 1) {
    let alive = true;
    const unlisten = isTauri()
      ? listen<Pomodoro>("pomodoro-snapshot", (event) => {
          if (alive) accept(event.payload);
        })
      : undefined;
    void unlisten?.catch((cause) => {
      if (alive) publish({ error: errorMessage(cause) });
    });
    // Native snapshots arrive every second; browser development has its own single polling source.
    const timer = window.setInterval(
      () => void refreshPomodoro(),
      isTauri() ? 10_000 : 1000,
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
  return { ...state, remaining, refresh: refreshPomodoro };
}
async function write(path: string, method: string, body: object) {
  if (store.busy) throw new Error("番茄钟正在保存，请稍候再试。");
  publish({ busy: true, error: "" });
  try {
    const value = await api<Pomodoro>(path, method, body, { timeoutMs: 5000 });
    accept(value);
    if (isTauri()) void emit("pomodoro-snapshot", value).catch(() => {});
    return value;
  } catch (cause) {
    await refreshPomodoro();
    publish({ error: errorMessage(cause) });
    throw cause;
  } finally {
    publish({ busy: false });
  }
}
export async function pomodoroAction(action: Action, title = "") {
  if (!store.data && action !== "pause_exit") return Promise.resolve(undefined);
  const value = await write("/pomodoro/actions", "POST", {
    action,
    title,
    expected_revision: store.data?.revision,
  });
  return value;
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
export function pomodoroStatus(data: Pomodoro) {
  if (data.status === "paused") return "已暂停";
  return {
    idle: "准备开始",
    focus: "专注中",
    waiting_break: "专注完成",
    break: "休息中",
    waiting_focus: "准备下一轮",
  }[data.phase];
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
