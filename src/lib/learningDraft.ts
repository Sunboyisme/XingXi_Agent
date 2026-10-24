import { registerLearningFlush } from "./learningLifecycle";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Attachment, type Lesson } from "./api";
import { draftImages, type LearningDraftOptions, type LearningSession } from "./learningSessions";

type Draft = { nodeId: string; lessonId: string; sessionId: string; answer: string; images: Attachment[]; dirty: boolean };
const keyFor = (draft: Draft) => draft.sessionId ? `bai-learning-session-draft:${draft.sessionId}:${draft.nodeId}` : `bai-learning-draft:${draft.nodeId}`;

export function clearLearningDraft(nodeId: string, sessionId?: string) {
  try {
    localStorage.removeItem(`bai-learning-draft:${nodeId}`);
    if (sessionId) localStorage.removeItem(`bai-learning-session-draft:${sessionId}:${nodeId}`);
  } catch { /* A storage failure must not erase the visible answer. */ }
}

export function clearLearningGoalDrafts(nodeIds: string[]) {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const key of keys) if (key?.startsWith("bai-learning-session-draft:") && nodeIds.some((node) => key.endsWith(`:${node}`))) localStorage.removeItem(key);
    nodeIds.forEach((node) => clearLearningDraft(node));
  } catch { /* Server deletion has already completed; remaining cache cannot re-create records. */ }
}

export function useLearningDraft(nodeId: string, lesson: Lesson | null, options?: LearningDraftOptions) {
  const [answer, setAnswerState] = useState("");
  const [images, setImagesState] = useState<Attachment[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<LearningSession | null>(null);
  const current = useRef<Draft>({ nodeId: "", lessonId: "", sessionId: "", answer: "", images: [], dirty: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const revisions = useRef(new Map<string, number>());
  const savedDrafts = useRef(new Map<string, string>());
  const blocked = useRef(new Set<string>());
  const callbacks = useRef(options);
  callbacks.current = options;
  const sessionId = options?.session?.status !== "ended" ? options?.session?.id || "" : "";
  const lessonId = lesson?.node_id === nodeId ? lesson.id : "";
  const awaiting = Boolean(lessonId && ["awaiting_submission", "reviewed"].includes(lesson?.state || ""));

  function enqueue(draft: Draft) {
    if (!draft.sessionId || !draft.lessonId || !draft.dirty) return chain.current;
    if (blocked.current.has(draft.sessionId)) return Promise.reject(new Error("请先选择使用哪份草稿，本机输入仍保留。"));
    const fingerprint = JSON.stringify([draft.lessonId, draft.answer, draft.images.map((item) => item.id)]);
    if (savedDrafts.current.get(keyFor(draft)) === fingerprint) {
      current.current.dirty = false;
      return chain.current.catch(() => {});
    }
    if (current.current.sessionId === draft.sessionId) setSaving(true);
    chain.current = chain.current.catch(() => {}).then(async () => {
      try {
        if (blocked.current.has(draft.sessionId)) throw new Error("请先处理草稿冲突，本机输入仍保留。");
        const saved = await api<LearningSession>(`/learning/sessions/${draft.sessionId}/draft`, "PUT", {
          node_id: draft.nodeId, lesson_id: draft.lessonId, answer: draft.answer,
          attachment_ids: draft.images.map((item) => item.id), revision: revisions.current.get(draft.sessionId),
        });
        revisions.current.set(draft.sessionId, saved.draft_revision);
        savedDrafts.current.set(keyFor(draft), fingerprint);
        if (current.current.sessionId === draft.sessionId && current.current.nodeId === draft.nodeId &&
            current.current.answer === draft.answer && JSON.stringify(current.current.images.map((item) => item.id)) === JSON.stringify(draft.images.map((item) => item.id))) {
          current.current.dirty = false;
          persistLocal(current.current);
        }
        try { localStorage.removeItem(`bai-learning-draft:${draft.nodeId}`); } catch { /* Keep server success. */ }
      } catch (cause) {
        if ((cause as Error).message.includes("草稿已在其他操作中更新")) {
          blocked.current.add(draft.sessionId);
          try {
            const remote = await api<LearningSession>(`/learning/sessions/${draft.sessionId}`);
            if (current.current.sessionId === draft.sessionId) setConflict(remote);
          } catch { /* Original conflict is still reported and the local copy is retained. */ }
        }
        // A conflicting draft is never retried with a newer revision behind the user's back.
        // Reopening the learning page retrieves the current server copy while retaining local text.
        callbacks.current?.onError(`草稿已保留在本机，但保存到会话失败：${(cause as Error).message}`);
        throw cause;
      } finally {
        if (current.current.sessionId === draft.sessionId) setSaving(false);
      }
    });
    void chain.current.catch(() => {});
    return chain.current;
  }

  useLayoutEffect(() => {
    let nextAnswer = "", nextImages: Attachment[] = [];
    const draft: Draft = { nodeId, lessonId: awaiting ? lessonId : "", sessionId, answer: "", images: [], dirty: false };
    const server = callbacks.current?.session;
    if (server?.id === sessionId) revisions.current.set(sessionId, server.draft_revision);
    let migrated = false;
    let conflictOnRestore = false;
    if (awaiting) {
      const remote = server?.draft;
      if (remote?.node_id === nodeId && remote.lesson_id === lessonId) {
        nextAnswer = remote.answer || "";
        nextImages = draftImages(remote.attachment_ids || []);
      }
      try {
        const own = localStorage.getItem(keyFor(draft));
        const legacy = !own && sessionId ? localStorage.getItem(`bai-learning-draft:${nodeId}`) : null;
        const saved = JSON.parse(own || legacy || "null");
        if ((saved?.version === 1 || saved?.version === 2) && saved.lessonId === lessonId &&
            typeof saved.answer === "string" && Array.isArray(saved.images)) {
          const differs = saved.answer !== nextAnswer || JSON.stringify(saved.images.map((item: Attachment) => item.id)) !== JSON.stringify(nextImages.map((item) => item.id));
          // A clean local cache may be older than another window's saved draft.
          if (!(saved.version === 2 && saved.dirty === false && differs)) {
            nextAnswer = saved.answer;
            nextImages = saved.images.filter((item: Attachment) => item && typeof item.id === "string" && typeof item.name === "string");
            migrated = Boolean(legacy);
            conflictOnRestore = Boolean(sessionId && differs && remote?.node_id === nodeId &&
              remote.lesson_id === lessonId && (remote.answer || remote.attachment_ids.length) &&
              saved.revision !== server?.draft_revision);
          }
        }
      } catch { /* Invalid cache is ignored; the saved server draft remains available. */ }
    } else if (lessonId) clearLearningDraft(nodeId, sessionId);
    draft.answer = nextAnswer;
    draft.images = nextImages;
    const remote = server?.draft;
    draft.dirty = Boolean(sessionId && awaiting && (migrated ||
      nextAnswer !== (remote?.answer || "") || JSON.stringify(nextImages.map((item) => item.id)) !== JSON.stringify(remote?.attachment_ids || [])));
    current.current = draft;
    if (conflictOnRestore) blocked.current.add(sessionId);
    setConflict(blocked.current.has(sessionId) && server ? server : null);
    setAnswerState(nextAnswer);
    setImagesState(nextImages);
    if (sessionId) persistLocal(draft);
    if (migrated && !conflictOnRestore) {
      persistLocal(draft);
      void enqueue({ ...draft }).catch(() => {});
    }
    return () => {
      clearTimeout(timer.current);
      const previous = current.current;
      if (previous.sessionId && previous.lessonId && previous.dirty)
        void enqueue({ ...previous }).catch(() => {});
    };
    // Restore only when the actual editing scope changes, never on a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, lessonId, awaiting, sessionId]);

  useEffect(() => {
    const session = options?.session;
    if (session) revisions.current.set(session.id, Math.max(revisions.current.get(session.id) || 0, session.draft_revision));
  }, [options?.session?.id, options?.session?.draft_revision]);

  useEffect(() => registerLearningFlush(flush), []);

  function persistLocal(draft: Draft) {
    if (!draft.lessonId) return;
    try {
      if (!draft.answer && !draft.images.length && (!draft.sessionId || !draft.dirty)) localStorage.removeItem(keyFor(draft));
      else localStorage.setItem(keyFor(draft), JSON.stringify({ version: draft.sessionId ? 2 : 1,
        lessonId: draft.lessonId, answer: draft.answer, images: draft.images,
        revision: revisions.current.get(draft.sessionId), dirty: draft.dirty }));
    } catch { callbacks.current?.onError("无法写入本机草稿缓存，请先保留输入内容。"); }
  }
  function changed() {
    current.current.dirty = true;
    const draft = { ...current.current };
    persistLocal(draft);
    clearTimeout(timer.current);
    if (draft.sessionId && draft.lessonId) timer.current = setTimeout(() => { void enqueue(draft).catch(() => {}); }, 600);
  }
  function setAnswer(value: string) { current.current.answer = value; setAnswerState(value); changed(); }
  function setImages(value: Attachment[]) { current.current.images = value; setImagesState(value); changed(); }
  async function flush() {
    clearTimeout(timer.current);
    await enqueue({ ...current.current });
  }
  function clear() {
    clearTimeout(timer.current);
    clearLearningDraft(current.current.nodeId, current.current.sessionId);
    current.current = { ...current.current, answer: "", images: [], dirty: false };
    setAnswerState(""); setImagesState([]);
  }
  function clearIfUnchanged(submitted: { nodeId: string; lessonId: string; answer: string; attachment_ids: string[] }) {
    const draft = current.current;
    if (draft.nodeId === submitted.nodeId && draft.lessonId === submitted.lessonId && draft.answer === submitted.answer &&
        JSON.stringify(draft.images.map((item) => item.id)) === JSON.stringify(submitted.attachment_ids)) clear();
  }
  async function resolveConflict(use: "remote" | "local") {
    if (!conflict || conflict.id !== current.current.sessionId) return;
    revisions.current.set(conflict.id, conflict.draft_revision);
    if (use === "remote") {
      if (conflict.draft.node_id !== current.current.nodeId || conflict.draft.lesson_id !== current.current.lessonId) {
        callbacks.current?.onError("会话中的草稿对应其他课程，请先重新进入对应知识点。本机输入仍保留。");
        return;
      }
      current.current = { ...current.current, answer: conflict.draft.answer,
        images: draftImages(conflict.draft.attachment_ids), dirty: false };
      setAnswerState(current.current.answer); setImagesState(current.current.images);
      persistLocal(current.current);
    }
    blocked.current.delete(conflict.id);
    chain.current = chain.current.catch(() => {});
    setConflict(null);
    if (use === "local") {
      current.current.dirty = true;
      try { await enqueue({ ...current.current }); } catch { /* The normal save error remains visible. */ }
    }
  }
  return { answer, setAnswer, images, setImages, saving, flush, clear, clearIfUnchanged, conflict, resolveConflict };
}
