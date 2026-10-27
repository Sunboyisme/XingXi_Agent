export function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

/** 提取可展示的错误信息；Tauri invoke 失败时抛出的是字符串而不是 Error。 */
export function errorMessage(
  cause: unknown,
  fallback = "操作未完成，请稍后重试。",
) {
  if (cause instanceof Error) return cause.message || fallback;
  if (typeof cause === "string" && cause) return cause;
  return fallback;
}

/** 内容未变化时沿用旧对象，避免轮询刷新引起无谓的重新渲染。 */
export function keepIfSame<T>(next: T) {
  return <C extends T | null | undefined>(current: C): C | T =>
    JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

/** 尚未处理的提醒：待发送或已弹出但未确认。 */
export const isActiveNotification = (note: { status: string }) =>
  note.status === "pending" || note.status === "presented";
