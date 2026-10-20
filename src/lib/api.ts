import { invoke, isTauri } from "@tauri-apps/api/core";
import type { components } from "./api.generated";

type Schemas = components["schemas"];
export type CalendarEvent = Schemas["PlanRead"];
export type CalendarEventWrite = Schemas["PlanWrite"];
export type Skill = Schemas["SkillRead"];
export type SkillPreview = Schemas["SkillPreview"];
export type Artifact = Schemas["ArtifactRead"];
export type Presentation = Schemas["PresentationRead"];
export type Settings = Schemas["SettingsRead"];
export type Tool = Schemas["ToolRead"];
export type MCPServer = Schemas["MCPServerRead"];
export type MCPServerWrite = Schemas["MCPServerWrite"];
export type Conversation = Schemas["ConversationRead"];
export type Message = Schemas["MessageRead"];
export type Run = Schemas["RunRead"];
export type Goal = Schemas["GoalRead"];
export type Node = Schemas["NodeRead"];
export type Lesson = Schemas["LessonRead"];
export type Memory = Schemas["MemoryRead"];
export type Notification = Schemas["NotificationRead"];
export type Attachment = Schemas["AttachmentRead"];
export type RunEvent = { kind: string; data: Record<string, unknown> };

let connection: { url: string; token: string } | undefined;
async function connect() {
  if (!connection)
    connection = isTauri()
      ? await invoke("backend_config")
      : { url: "/api/v1", token: "" };
  return connection!;
}

export async function fetchApi(path: string, options: RequestInit = {}) {
  const { url, token } = await connect();
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(url + path, { ...options, headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail =
      typeof data.detail === "string"
        ? data.detail
        : "请求未完成，请检查输入并重试。";
    throw new Error(detail);
  }
  return response;
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return (
    await fetchApi(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  ).json();
}

export async function uploadImage(file: File): Promise<Attachment> {
  const body = new FormData();
  body.append("file", file);
  return (await fetchApi("/attachments", { method: "POST", body })).json();
}

export async function uploadFile(file: File): Promise<Attachment> {
  const body = new FormData();
  body.append("file", file);
  return (await fetchApi("/files", { method: "POST", body })).json();
}

export async function readEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetchApi(`/runs/${runId}/events`, { signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (data) onEvent(JSON.parse(data.slice(6)));
      }
    }
  } finally {
    reader.releaseLock();
  }
  return api<Run>(`/runs/${runId}`);
}
