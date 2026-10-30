import { isTauri } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { isActiveRun, isSilentDesktopTask, type DesktopTaskActivity } from "./avatarActivity";

const inboxKey = "xiaoxi-desktop-task-inbox-v1";
export const DESKTOP_TASK_READ_PREFIX = "xiaoxi-desktop-task-read:";
export type DesktopTaskRead = { conversationId?: string; runId?: string; at: number };
const stamp = (task: DesktopTaskActivity) => Date.parse(task.updatedAt || "") || 0;
function receiptKey(value: DesktopTaskRead) {
  return `${DESKTOP_TASK_READ_PREFIX}${value.runId ? `run:${value.runId}` : `conversation:${value.conversationId}`}`;
}
function readStamp(key: string) {
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}
export function markDesktopTaskRead(value: Omit<DesktopTaskRead, "at">) {
  if (!value.runId && !value.conversationId) return;
  const receipt = { ...value, at: Date.now() };
  const key = receiptKey(receipt);
  try { localStorage.setItem(key, String(Math.max(receipt.at, readStamp(key)))); } catch { /* Keep the current desktop session usable. */ }
  if (isTauri()) void emitTo("pet", "desktop-task-read", receipt).catch(() => {});
}

/** Keep every observed unread task, including entries outside the recent-run polling page. */
export class DesktopTaskInbox {
  private tasks = new Map<string, DesktopTaskActivity>();
  private receipts = new Map<string, number>();
  private saved = "";
  constructor() {
    try {
      const values: DesktopTaskActivity[] = JSON.parse(localStorage.getItem(inboxKey) || "[]");
      if (Array.isArray(values)) for (const task of values) {
        if (typeof task?.runId === "string" && typeof task.runStatus === "string" && !isSilentDesktopTask(task)) this.tasks.set(task.runId, task);
      }
    } catch { /* A missing or invalid local inbox starts empty. */ }
  }
  accept(values: DesktopTaskActivity[]) {
    for (const task of values) {
      if (isSilentDesktopTask(task)) { this.tasks.delete(task.runId); continue; }
      if (!task.runId || !task.runStatus) continue;
      const old = this.tasks.get(task.runId);
      if (old && (["completed", "failed", "cancelled"].includes(old.runStatus) && isActiveRun(task.runStatus) || stamp(old) > stamp(task))) continue;
      this.tasks.set(task.runId, {
        ...task,
        source: task.source === "poll" && old ? old.source : task.source,
        title: task.source === "poll" && old ? old.title : task.title,
      });
    }
    return this.list();
  }
  read(value: DesktopTaskRead) {
    const key = receiptKey(value);
    this.receipts.set(key, Math.max(value.at, this.receipts.get(key) || 0));
    return this.list();
  }
  list(persist = true) {
    const groups = new Map<string, DesktopTaskActivity>();
    for (const [id, task] of this.tasks) {
      const keys = [`${DESKTOP_TASK_READ_PREFIX}run:${id}`, `${DESKTOP_TASK_READ_PREFIX}conversation:${task.conversationId}`];
      const read = Math.max(...keys.map(key => Math.max(readStamp(key), this.receipts.get(key) || 0)));
      if (read && stamp(task) <= read) { this.tasks.delete(id); continue; }
      if (task.hasNextRun) continue;
      const key = task.taskId || id;
      const old = groups.get(key);
      if (!old || stamp(task) >= stamp(old)) groups.set(key, task);
    }
    const serialized = JSON.stringify([...this.tasks.values()]);
    if (persist && serialized !== this.saved) {
      this.saved = serialized;
      try { localStorage.setItem(inboxKey, serialized); } catch { /* Retain the in-memory inbox when storage is full. */ }
    }
    return [...groups.values()].sort((a, b) => stamp(b) - stamp(a));
  }
}
