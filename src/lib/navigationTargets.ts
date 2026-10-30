import type { SettingsTab } from "@/components/SettingsPage";

const settingsTabs: Record<SettingsTab, true> = {
  general: true,
  appearance: true,
  desktop: true,
  connections: true,
  services: true,
  tools: true,
  skills: true,
  runtimes: true,
  wechat: true,
  memories: true,
  costs: true,
  data: true,
};

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && Object.hasOwn(settingsTabs, value);
}
