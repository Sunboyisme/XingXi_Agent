import type { components } from "./api.generated";

export type TranslationLanguage = NonNullable<
  components["schemas"]["DesktopAction"]["target_language"]
>;
export const translationLanguages: {
  value: TranslationLanguage;
  label: string;
}[] = [
  { value: "auto", label: "自动选择语言" },
  { value: "简体中文", label: "简体中文" },
  { value: "繁體中文", label: "繁体中文" },
  { value: "English", label: "英语" },
  { value: "日本語", label: "日语" },
  { value: "한국어", label: "韩语" },
  { value: "Français", label: "法语" },
  { value: "Deutsch", label: "德语" },
  { value: "Español", label: "西班牙语" },
  { value: "Português", label: "葡萄牙语" },
  { value: "Italiano", label: "意大利语" },
  { value: "Русский", label: "俄语" },
  { value: "العربية", label: "阿拉伯语" },
  { value: "ไทย", label: "泰语" },
  { value: "Tiếng Việt", label: "越南语" },
  { value: "Bahasa Indonesia", label: "印度尼西亚语" },
  { value: "हिन्दी", label: "印地语" },
];
