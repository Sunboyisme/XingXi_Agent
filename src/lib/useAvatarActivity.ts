import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import type { Run } from "./api";
import { activityPhase, desktopTask, type AvatarActivity } from "./avatarActivity";

export function useAvatarActivity(scope: string, source: "main" | "quick") {
  const [activity, setActivity] = useState<AvatarActivity>();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const current = useRef<{ scope: string; id: string; finished: boolean } | undefined>(undefined);
  const publish = useCallback((run: Run) => {
    if (isTauri()) void emitTo("pet", "desktop-task", desktopTask(run, source)).catch(() => {});
  }, [source]);
  const begin = useCallback((run: Run) => {
    if (current.current?.scope === scopeRef.current && current.current.id === run.id) return;
    current.current = { scope: scopeRef.current, id: run.id, finished: false };
    setActivity({ runId: run.id, phase: "working", startedAt: Date.now() });
    publish({ ...run, status: "running" });
  }, [publish]);
  const finish = useCallback((run: Run, visible = !document.hidden) => {
    if (current.current?.scope !== scopeRef.current || current.current?.id !== run.id || current.current.finished) return;
    current.current.finished = true;
    const phase = activityPhase(desktopTask(run, source));
    setActivity({ runId: run.id, phase: phase === "success" && !visible ? "idle" : phase, startedAt: Date.now() });
    publish(run);
  }, [publish, source]);
  const clearCelebration = useCallback(() => {
    setActivity(value => value?.phase === "success" ? { ...value, phase: "idle" } : value);
  }, []);
  useEffect(() => {
    current.current = undefined;
    setActivity(undefined);
  }, [scope]);
  useEffect(() => {
    const visibility = () => { if (document.hidden) clearCelebration(); };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [clearCelebration]);
  return { activity, begin, finish, clearCelebration };
}
