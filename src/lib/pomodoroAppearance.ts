export const pomodoroThemes = [
  { value: "follow", label: "跟随主界面" },
  { value: "warm-dark", label: "暖墨" },
  { value: "cream", label: "奶油" },
  { value: "mist-blue", label: "雾蓝" },
  { value: "sage", label: "苔绿" },
  { value: "plum", label: "莓紫" },
] as const;
export type PomodoroTheme = (typeof pomodoroThemes)[number]["value"];
export function readPomodoroTheme(value: unknown): PomodoroTheme {
  return (
    pomodoroThemes.find((theme) => theme.value === value)?.value || "follow"
  );
}
