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
export function localDateTime(value: string) {
  const date = new Date(value);
  // The v0.1 UI displays and schedules reminders in Asia/Shanghai.
  return new Date(date.getTime() + 8 * 3600000)
    .toISOString()
    .slice(0, 16);
}
