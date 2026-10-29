import { invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import {
  api,
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
  petX: number | null;
  petY: number | null;
  petSize: number;
  petOffsetX?: number | null;
  petOffsetY?: number | null;
};
type SpeechProfile = {
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
export type QuickDraft = {
  text: string;
  attachments: Attachment[];
  conversationId: string | null;
  runId: string | null;
  modelKey: string;
};
export function emptyQuickDraft(): QuickDraft {
  return {
    text: "",
    attachments: [],
    conversationId: null,
    runId: null,
    modelKey: "",
  };
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
) {
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
export function desktopListen<T>(event: string, handler: (payload: T) => void) {
  return listen<T>(event, (e) => handler(e.payload));
}
export { invoke, emitTo, api, readEvents };
export type { Attachment, Run, Settings };
