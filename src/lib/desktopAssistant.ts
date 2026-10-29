import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import {
  api,
  fetchApi,
  readEvents,
  uploadFile,
  uploadImage,
  type Attachment,
  type Run,
  type Settings,
} from "./api";

export type DesktopPreferences = {
  enabled: boolean;
  pet: boolean;
  selection: boolean;
  shortcut: string;
  petX: number | null;
  petY: number | null;
};
export type SpeechProfile = {
  provider: "siliconflow" | "bailian" | "custom";
  url: string;
  model: string;
  key_configured: boolean;
  api_key?: string;
};
export type SpeechSettings = {
  selected: SpeechProfile["provider"];
  profiles: SpeechProfile[];
};
export type ModelChoice = {
  provider_id: string;
  model_name: string;
  thinking_enabled?: boolean;
};
export type QuickDraft = {
  text: string;
  attachments: Attachment[];
  conversationId: string | null;
  runId: string | null;
  modelKey: string;
};
export const QUICK_KEY = "xiaoxi-desktop-draft-v1";
export function readQuickDraft(): QuickDraft {
  const fallback = {
    text: "",
    attachments: [],
    conversationId: null,
    runId: null,
    modelKey: "",
  };
  try {
    const value = JSON.parse(localStorage.getItem(QUICK_KEY) || "{}");
    return {
      text: typeof value.text === "string" ? value.text : "",
      attachments: Array.isArray(value.attachments)
        ? value.attachments
            .filter(
              (a: Attachment) =>
                a &&
                typeof a.id === "string" &&
                typeof a.media_type === "string",
            )
            .slice(0, 4)
        : [],
      conversationId:
        typeof value.conversationId === "string" ? value.conversationId : null,
      runId: typeof value.runId === "string" ? value.runId : null,
      modelKey: typeof value.modelKey === "string" ? value.modelKey : "",
    };
  } catch {
    return fallback;
  }
}
export function saveQuickDraft(draft: QuickDraft) {
  try {
    localStorage.setItem(QUICK_KEY, JSON.stringify(draft));
  } catch {
    /* Keep the active draft usable if WebView storage is full. */
  }
}
export const desktopError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function models(settings?: Settings) {
  return (
    settings?.providers.flatMap((p) =>
      p.models.map((m) => ({
        key: `${p.id}:${m.name}`,
        label: `${p.label} · ${m.name}`,
        vision: m.vision_enabled,
        selection: { provider_id: p.id, model_name: m.name },
      })),
    ) || []
  );
}
export function selectedModel(
  settings: Settings | undefined,
  key: string,
): ModelChoice | undefined {
  return models(settings).find((m) => m.key === key)?.selection;
}
export async function addDesktopFile(file: File): Promise<Attachment> {
  const image = /\.(png|jpe?g|webp)$/i.test(file.name);
  if (!image && !/\.(pdf|docx|xlsx|txt|md|csv|json)$/i.test(file.name))
    throw new Error("暂不支持这个附件格式");
  if (file.size > (image ? 10 : 20) * 1024 * 1024)
    throw new Error(image ? "图片不能超过 10 MB" : "文件不能超过 20 MB");
  let value = await (image ? uploadImage(file) : uploadFile(file));
  const deadline = Date.now() + 90000;
  while (["queued", "parsing"].includes(value.file_status || "")) {
    if (Date.now() > deadline) throw new Error("附件解析超时，请稍后重新添加");
    await new Promise((resolve) => setTimeout(resolve, 500));
    value = await api<Attachment>(`/attachments/${value.id}`);
  }
  if (value.file_status === "failed")
    throw new Error(value.error || "附件解析失败");
  return value;
}
export async function imageFile(dataUrl: string) {
  return new File(
    [await (await fetch(dataUrl)).blob()],
    `截图-${Date.now()}.png`,
    { type: "image/png" },
  );
}
export async function copyText(text: string) {
  await invoke("plugin:clipboard-manager|write_text", { text });
}
export function desktopListen<T>(event: string, handler: (payload: T) => void) {
  return listen<T>(event, (e) => handler(e.payload));
}
export { invoke, emitTo, api, fetchApi, readEvents };
export type { Attachment, Run, Settings };
