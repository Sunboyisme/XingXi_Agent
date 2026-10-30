import type { Run } from "./api";

export const AVATAR_SUCCESS_MS = 1400;
export type AvatarActivity = {
  runId: string;
  phase: "idle" | "working" | "waiting" | "success";
  startedAt: number;
};
export type AvatarGesture = {
  kind: "press" | "pet" | "drag" | "drop";
  startedAt: number;
  variant?: "happy" | "wave";
};
export type DesktopTaskSnapshot = {
  kind?: string;
  runId: string;
  runStatus: string;
  taskId?: string | null;
  taskStatus?: string | null;
  hasNextRun?: boolean;
  conversationId?: string | null;
  source: "main" | "quick" | "poll";
  updatedAt?: string;
};
export type DesktopTaskActivity = DesktopTaskSnapshot & { title: string; status: string };
export const isActiveRun = (status: string) =>
  ["queued", "pending", "running"].includes(status);
// Inline selection/OCR/translation results have their own surface and no inbox entry.
export const isSilentDesktopTask = (task: DesktopTaskSnapshot) => task.kind === "desktop_action";
const isTerminalRun = (status: string) =>
  ["completed", "failed", "cancelled"].includes(status);
export function activityPhase(task: DesktopTaskSnapshot): AvatarActivity["phase"] {
  if (isActiveRun(task.runStatus)) return "working";
  if (task.runStatus !== "completed") return "idle";
  if (task.hasNextRun || (task.taskId && task.taskStatus !== "completed"))
    return "waiting";
  return "success";
}
export function desktopTask(run: Run, source: DesktopTaskSnapshot["source"]): DesktopTaskActivity {
  return presentDesktopTask({
    kind: run.kind,
    runId: run.id, runStatus: run.status, taskId: run.task_id,
    taskStatus: run.task_status, hasNextRun: typeof run.result?.next_run_id === "string",
    conversationId: run.conversation_id, source,
    updatedAt: run.updated_at,
  });
}
export function presentDesktopTask(task: DesktopTaskSnapshot): DesktopTaskActivity {
  const phase = activityPhase(task);
  const status = phase === "working" ? "正在处理…"
    : phase === "success" ? "回答完成，点击查看"
    : phase === "waiting" ? "等待继续，点击查看"
    : task.runStatus === "cancelled" ? "已停止" : "处理未完成，点击查看";
  return { ...task, title: task.source === "quick" ? "桌面问答" : "XiaoXi 任务", status };
}

/** Merge one polling batch atomically: one finished run must not hide another active run. */
export class PetActivities {
  private runs = new Map<string, DesktopTaskActivity>();
  private last: DesktopTaskActivity | undefined;
  activeIds() { return [...this.runs.values()].filter(value => isActiveRun(value.runStatus)).map(value => value.runId); }
  accept(values: DesktopTaskActivity[]) {
    let finished: DesktopTaskActivity | undefined;
    for (const value of [...values].sort((a, b) => (Date.parse(a.updatedAt || "") || 0) - (Date.parse(b.updatedAt || "") || 0))) {
      if (isSilentDesktopTask(value)) {
        this.runs.delete(value.runId);
        if (this.last?.runId === value.runId) this.last = undefined;
        continue;
      }
      if (!value.runId || !value.runStatus) continue;
      const old = this.runs.get(value.runId);
      // Polling may still contain the pre-completion snapshot after a live result.
      if (old && isTerminalRun(old.runStatus) && isActiveRun(value.runStatus)) continue;
      const next = { ...value,
        source: value.source === "poll" && old ? old.source : value.source,
        title: value.source === "poll" && old ? old.title : value.title,
      };
      if (old && isActiveRun(old.runStatus) && !isActiveRun(next.runStatus)) finished = next;
      this.runs.set(value.runId, next);
      this.last = next;
    }
    const active = [...this.runs.values()].filter(value => isActiveRun(value.runStatus));
    const current = active.at(-1) || this.last;
    const success = !active.length && finished && activityPhase(finished) === "success" ? finished : undefined;
    // Keep all active entries; bound terminal deduplication to recent runs.
    if (this.runs.size > 512) {
      for (const [id, value] of this.runs) {
        if (this.runs.size <= 384) break;
        if (!isActiveRun(value.runStatus)) this.runs.delete(id);
      }
    }
    return { active: active.length > 0, current, success };
  }
}
