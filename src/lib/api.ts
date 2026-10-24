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
export type Project = Schemas["ProjectRead"];
export type Message = Schemas["MessageRead"];
export type Run = Schemas["RunRead"];
export type ComplexTask = {
  resume_run_id?: string | null;
  id: string;
  conversation_id: string;
  source_message_id: string;
  source_run_id?: string | null;
  created_at: string;
  updated_at: string;
  status: string;
  revision: number;
  goal: string;
  title?: string;
  reason: string;
  pending_messages: number;
  requirements: { constraints?: string[]; completion_criteria?: string[] };
  steps: {
    id: string;
    title: string;
    status: string;
    output: { content?: string };
  }[];
  artifacts: (Artifact & { task_revision: number; current: boolean })[];
  operations: {
    id: string;
    tool_id: string;
    name?: string;
    status: string;
    result: Record<string, unknown>;
  }[];
  result: { content?: string };
};
export type Goal = Omit<
  Schemas["GoalRead"],
  "outcome" | "weekly_minutes" | "target_date"
> & {
  outcome?: string;
  weekly_minutes?: number | null;
  target_date?: string | null;
};
export type Node = Schemas["NodeRead"];
export type Lesson = Schemas["LessonRead"];
export type LearningTurn = Schemas["LearningTurnRead"];
export type Memory = Schemas["MemoryRead"];
export type Notification = Schemas["NotificationRead"];
export type Attachment = Schemas["AttachmentRead"] & { local_path?: string };
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
  const dispatch = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) onEvent(JSON.parse(data));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        dispatch(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (done) {
        if (buffer.trim()) dispatch(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return api<Run>(`/runs/${runId}`);
}
