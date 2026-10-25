import { useEffect, useState } from "react";
import { fetchApi, type Message, type Settings } from "./api";
import { useGeneralPreferences } from "./generalPreferences";

export function useComposerPlaceholder(
  conversationId: string | null,
  messages: Message[],
  settings: Settings,
) {
  const { inputSuggestions } = useGeneralPreferences();
  const [value, setValue] = useState("");
  const contextKey = messages
    .slice(-8)
    .map((message) => `${message.id}:${message.updated_at}`)
    .join("|");
  const profile = settings.providers.find(
    (item) => item.id === settings.default_provider,
  );
  const modelKey = `${profile?.id}:${profile?.default_model}:${profile?.model_url}:${profile?.key_configured}`;
  useEffect(() => {
    setValue("");
    if (
      !inputSuggestions ||
      !conversationId ||
      !contextKey ||
      !profile?.key_configured
    )
      return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchApi(`/conversations/${conversationId}/input-suggestion`, {
        method: "POST",
        signal: controller.signal,
      })
        .then((response) => response.json())
        .then((result: { placeholder?: string | null }) => {
          if (
            !controller.signal.aborted &&
            typeof result.placeholder === "string"
          )
            setValue(result.placeholder);
        })
        .catch(() => {
          /* An optional hint never interrupts typing or shows an error. */
        });
    }, 900);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // Only persisted context or the application's default connection changes a hint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, contextKey, modelKey, inputSuggestions]);
  return inputSuggestions ? value : "";
}
