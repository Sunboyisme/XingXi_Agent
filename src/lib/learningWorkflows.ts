import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Attachment } from "./api";
import { registerLearningFlush } from "./learningLifecycle";
import { draftImages } from "./learningSessions";
import { errorMessage } from "./utils";

export type Intake = { id: string; messages: { role: string; content: string; message_id?: string; knowledge_sources?: import("@/components/KnowledgeSources").KnowledgeSource[] }[];
  summary: Record<string, string>; draft: string; draft_revision: number;
  status: string; goal_id: string | null; active_run_id: string | null };
export type Review = { id: string; created_at: string; goal_id: string; session_id: string | null; node_id: string;
  source: { node_title: string; basis: string }; exercise: string;
  turns: { id: string; answer: string; attachment_ids: string[]; feedback: Record<string, unknown> }[];
  draft: { answer?: string; attachment_ids?: string[] }; draft_revision: number; status: string; active_run_id: string | null };

export function useWorkflowDraft(kind: "intakes" | "reviews", row: Intake | Review | null, onError: (message: string) => void) {
  const [answer, setText] = useState("");
  const [images, setPictures] = useState<Attachment[]>([]);
  const current = useRef({ id: "", answer: "", images: [] as Attachment[], revision: 0, dirty: false });
  const callback = useRef(onError); callback.current = onError;
  const chain = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const key = (id: string) => `xiaoxi-${kind}-draft:${id}`;
  const saveLocal = () => { try { localStorage.setItem(key(current.current.id), JSON.stringify(current.current)); }
    catch { callback.current("无法保存本机草稿，请先保留输入内容。"); } };
  async function flush() {
    clearTimeout(timer.current);
    const target = { ...current.current };
    if (!target.id) return;
    const work = chain.current.catch(() => {}).then(async () => {
      if (!current.current.dirty || current.current.id !== target.id) return;
      const saved = await api<Intake | Review>(`/learning/${kind}/${target.id}/draft`, "PUT", {
        answer: target.answer, ...(kind === "reviews" ? { attachment_ids: target.images.map((image) => image.id) } : {}),
        revision: current.current.revision,
      });
      current.current.revision = saved.draft_revision;
      if (current.current.answer === target.answer && JSON.stringify(current.current.images) === JSON.stringify(target.images)) current.current.dirty = false;
      saveLocal();
    });
    chain.current = work;
    await work;
  }
  useLayoutEffect(() => {
    if (!row) return;
    const remote = typeof row.draft === "string" ? { answer: row.draft } : row.draft;
    let value = { id: row.id, answer: remote.answer || "", images: draftImages(remote.attachment_ids || []), revision: row.draft_revision, dirty: false };
    try {
      const local = JSON.parse(localStorage.getItem(key(row.id)) || "null");
      if (local?.dirty && local.id === row.id) {
        value = { ...value, answer: String(local.answer || ""), images: Array.isArray(local.images) ? local.images : [], dirty: true };
        if (local.revision !== row.draft_revision && (remote.answer || remote.attachment_ids?.length)) {
          value.revision = local.revision;
          callback.current("本机草稿与已保存版本不同，输入已保留；请重新读取后核对，尚未覆盖服务端。");
        }
      }
    } catch { /* Restore the saved server draft when the local cache is invalid. */ }
    current.current = value; setText(value.answer); setPictures(value.images);
    return () => { clearTimeout(timer.current); };
    // A refreshed row must not replace text typed since that request started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);
  useEffect(() => {
    if (row && !current.current.dirty) current.current.revision = row.draft_revision;
  }, [row?.draft_revision]);
  useEffect(() => registerLearningFlush(flush), []);
  function changed() {
    current.current.dirty = true; saveLocal(); clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch((cause) => callback.current(`草稿保存失败：${errorMessage(cause)}`)); }, 600);
  }
  function clear() {
    clearTimeout(timer.current); current.current.dirty = false; current.current.answer = ""; current.current.images = [];
    setText(""); setPictures([]); localStorage.removeItem(key(current.current.id));
  }
  return { answer, images, flush, clear,
    setAnswer(value: string) { current.current.answer = value; setText(value); changed(); },
    setImages(value: Attachment[]) { current.current.images = value; setPictures(value); changed(); } };
}
