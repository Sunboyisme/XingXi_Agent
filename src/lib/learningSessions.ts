import type { Attachment, Goal, LearningTurn } from "./api";

export type LearningGoalDetails = Goal & {
  outcome?: string;
  weekly_minutes?: number | null;
  target_date?: string | null;
};

export type SessionDraft = {
  node_id: string | null;
  lesson_id: string | null;
  answer: string;
  attachment_ids: string[];
};

export type LearningSession = {
  id: string;
  created_at: string;
  updated_at: string;
  goal_id: string;
  node_id: string | null;
  lesson_id: string | null;
  target_minutes: number | null;
  status: "active" | "paused" | "ended";
  summary: string;
  gaps: string[];
  next_step: string;
  started_at: string;
  paused_at: string | null;
  ended_at: string | null;
  last_studied_at: string | null;
  visited_node_ids: string[];
  draft: SessionDraft;
  draft_revision: number;
  turns: LearningTurn[];
};

export type LearningContinuation = {
  goal_id: string;
  goal_title: string;
  goal_status: string;
  node_id: string | null;
  node_title: string;
  lesson_id: string | null;
  session_id: string | null;
  status: string;
  summary: string;
  gaps: string[];
  next_step: string;
  last_studied_at: string | null;
};

export type LearningDraftOptions = {
  session: LearningSession | null;
  onError: (message: string) => void;
};

export function draftImages(ids: string[], local: Attachment[] = []): Attachment[] {
  return ids.map((id) => local.find((item) => item.id === id) || ({ id, name: "已保存的练习图片" } as Attachment));
}

export function learningDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "尚未开始";
}
