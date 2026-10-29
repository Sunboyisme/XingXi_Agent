export type ModelOptions = {
  thinking: boolean;
  thinkingOverride?: boolean;
  reasoningEffort?: string;
  contextTokens?: number;
};

export type ModelPreference = {
  version: 2;
  key: string;
  models: Record<string, ModelOptions>;
};

export const chatModelKey = (conversationId: string | null) =>
  `bai-chat-model:${conversationId || "new"}`;

export function readModelPreference(
  conversationId: string | null,
): ModelPreference {
  const empty: ModelPreference = { version: 2, key: "", models: {} };
  try {
    const value = JSON.parse(
      localStorage.getItem(chatModelKey(conversationId)) || "null",
    );
    if (typeof value?.key !== "string") return empty;
    if (value.version === 1) {
      return {
        ...empty,
        key: value.key,
        models: {
          [value.key]: { thinking: value.thinking === true },
        },
      };
    }
    if (
      value.version !== 2 ||
      !value.models ||
      typeof value.models !== "object"
    )
      return empty;
    const models = Object.fromEntries(
      Object.entries(value.models).flatMap(([key, raw]) => {
        if (!raw || typeof raw !== "object") return [];
        const option = raw as Record<string, unknown>;
        const tokens = option.contextTokens;
        return [
          [
            key,
            {
              thinking: option.thinking === true,
              ...(typeof option.thinkingOverride === "boolean"
                ? { thinkingOverride: option.thinkingOverride }
                : {}),
              ...(typeof option.reasoningEffort === "string"
                ? { reasoningEffort: option.reasoningEffort }
                : {}),
              ...(typeof tokens === "number" &&
              Number.isInteger(tokens) &&
              tokens >= 4096 &&
              tokens <= 2000000
                ? { contextTokens: tokens }
                : {}),
            },
          ],
        ];
      }),
    );
    return { version: 2, key: value.key, models };
  } catch {
    return empty;
  }
}

export function storeModelPreference(
  conversationId: string | null,
  value: ModelPreference,
) {
  try {
    localStorage.setItem(chatModelKey(conversationId), JSON.stringify(value));
  } catch {
    /* Preferences remain usable for this session when storage is unavailable. */
  }
}
