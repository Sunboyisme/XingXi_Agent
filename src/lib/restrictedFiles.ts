import { createContext } from "react";
import { api } from "./api";

export const RestrictedFileContext = createContext<string | null>(null);
export type FileSaveRequest = {
  id: string;
  artifact_id: string;
  name: string;
  digest: string;
  size: number;
  target: string;
  status: string;
  expires_at: string;
  error: string;
};
export type FileSession = {
  id: string;
  conversation_id: string;
  status: string;
  expires_at: string;
  grants: { path: string; kind: string; recursive: boolean }[];
  model_binding: {
    provider_id?: string;
    model_url?: string;
    model_name?: string;
  };
  read_count: number;
  read_bytes: number;
  saves: FileSaveRequest[];
  events: {
    action: string;
    detail: Record<string, unknown>;
    created_at: string;
  }[];
};
export async function proposeFileSave(
  conversationId: string,
  artifactId: string,
) {
  await api("/file-save-requests", "POST", {
    conversation_id: conversationId,
    artifact_id: artifactId,
  });
  window.dispatchEvent(new Event("xiaoxi-file-session-updated"));
}
