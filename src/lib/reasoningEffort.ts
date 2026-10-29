export const effortOptions = [
  { value: "minimal", label: "极低" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "更高" },
  { value: "max", label: "最高" },
  { value: "ultra", label: "极致" },
] as const;

export function effortLabel(value?: string | null) {
  return (
    effortOptions.find((option) => option.value === value)?.label ||
    "服务商默认"
  );
}
