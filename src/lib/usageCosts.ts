export type UsageModel = {
  provider_id: string;
  provider_label: string;
  model_name: string;
  kind: string;
};
export type UsagePrice = UsageModel & {
  id: string;
  created_at: string;
  currency: string;
  image_size: string;
  rates: Record<string, string>;
};
export type UsageCall = UsageModel & {
  id: string;
  created_at: string;
  purpose: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  image_count: number | null;
  estimated_cost: string | null;
  unknown_reason: string;
  price_snapshot: { currency?: string };
};
export type UsageGroup = UsageModel & {
  purpose: string;
  currency: string | null;
  calls: number;
  unknown_calls: number;
  known_calls: number;
  unknown_input_calls: number;
  unknown_output_calls: number;
  unknown_image_calls: number;
  unknown_cached_calls: number;
  unknown_cache_write_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  image_count: number;
  known_cost: string;
};
export type UsageReport = {
  total_calls: number;
  total_tokens: number | null;
  unknown_token_calls: number;
  unknown_calls: number;
  currencies: Record<string, string>;
  groups: UsageGroup[];
  calls: UsageCall[];
  has_more: boolean;
  offset: number;
  limit: number;
  historical_count: number;
  historical: {
    id: string;
    created_at: string;
    total_tokens: number;
    unknown_reason: string;
  }[];
};
export const usagePurposes: Record<string, string> = {
  input_suggestion: "输入建议",
  chat: "聊天",
  learning: "学习",
  complex_task: "复杂任务",
  context_compaction: "上下文压缩",
  image_reading: "图片理解",
  embedding: "Embedding",
  image_generation: "生图",
  connection_test: "连接测试",
};
export const usageStates: Record<string, string> = {
  started: "请求中",
  completed: "已返回",
  failed: "失败",
  interrupted: "中断",
};

export const USAGE_PAGE_SIZE = 10;
export function formatUsageAmount(value: string) {
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 8 });
}
export function usageModelKey(model: UsageModel) {
  return JSON.stringify([model.provider_id, model.model_name, model.kind]);
}
export function usageDateBefore(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
