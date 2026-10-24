import { DetailDialog } from "./ui/detail-dialog";
import { useEffect, useState, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Compass,
  FileQuestion,
  GraduationCap,
  Loader2,
  Lightbulb,
  Plus,
  RotateCcw,
  SkipForward,
  Sparkles,
  Settings2,
  Target,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { CreationPage } from "./CreationPage";
import { DateTimePicker } from "./DateTimePicker";
import {
  api,
  readEvents,
  type Goal,
  type Node,
  type Lesson,
  type LearningTurn,
  type Run,
} from "@/lib/api";
import { clearLearningGoalDrafts, useLearningDraft } from "@/lib/learningDraft";
import {
  type LearningContinuation,
  type LearningGoalDetails,
  type LearningSession,
  learningDate,
  isStudied,
} from "@/lib/learningSessions";
import {
  EmptyState,
  ErrorNotice,
  Markdown,
  nodeStatus,
  ConfirmDelete,
  Toast,
} from "./common";
import { BaiAvatar } from "./BaiAvatar";
import {
  LearningConversation,
  LearningPendingReply,
} from "./LearningConversation";
import { LearningSessionPanel } from "./LearningSessionPanel";
import { LearningComposer } from "./LearningComposer";
import { LearningIntakePage } from "./LearningIntakePage";
import { LearningReviewPanel } from "./LearningReviewPanel";
import { flushLearningDrafts } from "@/lib/learningLifecycle";

export function LearningPage({
  goals,
  refresh,
  onSettings,
  createRequested,
  openRequest,
  onOpenHandled,
}: {
  goals: Goal[];
  refresh: () => Promise<void>;
  onSettings: () => void;
  createRequested?: number;
  openRequest?: { goalId: string; sessionId?: string; key: number };
  onOpenHandled?: () => void;
}) {
  const [goalId, setGoalId] = useState(
    () => localStorage.getItem("bai-current-goal") || "",
  );
  const [nodeId, setNodeId] = useState("");
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [turns, setTurns] = useState<LearningTurn[]>([]);
  const [open, setOpen] = useState(Boolean(createRequested));
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [foundation, setFoundation] = useState("");
  const [outcome, setOutcome] = useState("");
  const [weeklyMinutes, setWeeklyMinutes] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [useBeginnerDefaults, setUseBeginnerDefaults] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopLock = useRef(false);
  const reviewReminderLock = useRef(false);
  const selectedGoalId = useRef(goalId);
  selectedGoalId.current = goalId;
  const [run, setRun] = useState<Run | null>(null);
  const [session, setSession] = useState<LearningSession | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [sessionBusy, setSessionBusy] = useState(false);
  const [continuations, setContinuations] = useState<
    Record<string, LearningContinuation>
  >({});
  const submittedDrafts = useRef(
    new Map<
      string,
      {
        nodeId: string;
        lessonId: string;
        answer: string;
        attachment_ids: string[];
      }
    >(),
  );
  const pinnedSession = useRef<{ goalId: string; id: string } | null>(null);
  const continuityVersion = useRef(0);
  const [learningStream, setLearningStream] = useState<{
    nodeId: string;
    stage: string;
    fields: Record<string, string>;
  } | null>(null);
  const [pendingReply, setPendingReply] = useState<{
    nodeId: string;
    answer: string;
    attachmentIds: string[];
  } | null>(null);
  const lessonScroll = useRef<HTMLDivElement>(null);
  const followReply = useRef(false);
  useEffect(() => {
    if (!followReply.current) return;
    const frame = requestAnimationFrame(() => {
      const viewport = lessonScroll.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [learningStream, pendingReply, turns, busy]);
  useEffect(() => {
    followReply.current = false;
    setPendingReply(null);
  }, [nodeId]);
  const {
    answer,
    setAnswer,
    images,
    setImages,
    flush: flushDraft,
    clearIfUnchanged: clearSubmittedDraft,
    conflict: draftConflict,
    resolveConflict: resolveDraftConflict,
  } = useLearningDraft(nodeId, lesson, { session, onError: setError });
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const finishingSection = useRef(false);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const [removedGoalIds, setRemovedGoalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const availableGoals = goals.filter((item) => !removedGoalIds.has(item.id));
  const [outlineOpen, setOutlineOpen] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 1100px)").matches
      : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 1100px)");
    const resize = () => setOutlineOpen(media.matches);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    const toggle = () => setOutlineOpen((value) => !value);
    window.addEventListener("xiaoxi-toggle-learning-outline", toggle);
    return () => window.removeEventListener("xiaoxi-toggle-learning-outline", toggle);
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("xiaoxi-learning-outline-state", { detail: { available: Boolean(goalId && !open), expanded: outlineOpen } }));
    return () => { window.dispatchEvent(new CustomEvent("xiaoxi-learning-outline-state", { detail: { available: false, expanded: false } })); };
  }, [goalId, open, outlineOpen]);
  const answerDropTarget = useRef<HTMLDivElement>(null);
  const watch = useRef<AbortController | null>(null);
  const activeNode = useRef(nodeId);
  activeNode.current = nodeId;
  const selectedGoal = availableGoals.find((x) => x.id === goalId);
  const goal = selectedGoal || null;
  const node = goal?.nodes.find((x) => x.id === nodeId);
  const nextNode =
    goal?.nodes.find(
      (value) =>
        value.ordinal > (node?.ordinal ?? -1) && !isStudied(value.status),
    ) ||
    goal?.nodes.find(
      (value) => value.id !== nodeId && !isStudied(value.status),
    );
  const pinnedLessonId =
    session?.id === pinnedSession.current?.id && session?.node_id === nodeId
      ? session?.lesson_id
      : null;
  function selectGoal(value: Goal) {
    pinnedSession.current = null;
    continuityVersion.current += 1;
    const previous = sessionRef.current;
    if (previous?.status === "active")
      void api(`/learning/sessions/${previous.id}/pause`, "POST").catch(
        (cause: Error) => setError(cause.message),
      );
    setSession(null);
    watch.current?.abort();
    setBusy(false);
    setRun(null);
    setStopping(false);
    stopLock.current = false;
    setGoalId(value.id);
    localStorage.setItem("bai-current-goal", value.id);
    setNodeId(value.current_node_id || value.nodes[0]?.id || "");
    setError("");
  }
  function openGoalEditor(value?: LearningGoalDetails) {
    setEditingGoalId(value?.id || null);
    setTitle(value?.title || "");
    setObjective(value?.objective || "");
    setFoundation(value?.foundation || "");
    setOutcome(value?.outcome || "");
    setWeeklyMinutes(value?.weekly_minutes ? String(value.weekly_minutes) : "");
    setTargetDate(value?.target_date || "");
    setUseBeginnerDefaults(false);
    setOpen(true);
  }
  useEffect(() => {
    const ended = () => { watch.current?.abort(); setBusy(false); setRun(null); setReviewOpen(false); setPendingReply(null); setLearningStream(null); void reloadContinuity().catch((cause: Error) => setError(cause.message)); };
    window.addEventListener("xiaoxi-learning-ended", ended);
    return () => window.removeEventListener("xiaoxi-learning-ended", ended);
  }, []);
  async function reloadContinuity(targetGoal = selectedGoalId.current) {
    if (!targetGoal) return;
    const request = ++continuityVersion.current;
    const value = await api<LearningContinuation>(
      `/learning/goals/${targetGoal}/continuation`,
    );
    const pinned =
      pinnedSession.current?.goalId === targetGoal
        ? pinnedSession.current.id
        : null;
    const id = pinned || value.session_id;
    const saved = id
      ? await api<LearningSession>(`/learning/sessions/${id}`)
      : null;
    if (
      request !== continuityVersion.current ||
      selectedGoalId.current !== targetGoal
    )
      return;
    if (saved && saved.goal_id !== targetGoal)
      throw new Error("接续卡与学习目标不一致，请从学习列表继续。");
    setSession(saved);
    const nodeTitle =
      goals
        .find((item) => item.id === targetGoal)
        ?.nodes.find((item) => item.id === saved?.node_id)?.title || "";
    setContinuations((previous) => ({
      ...previous,
      [targetGoal]:
        pinned && saved
          ? {
              ...value,
              session_id: saved.id,
              node_id: saved.node_id,
              node_title: nodeTitle,
              lesson_id: saved.lesson_id,
              status: saved.status,
              summary: saved.summary,
              gaps: saved.gaps,
              next_step: saved.next_step,
              last_studied_at: saved.last_studied_at,
            }
          : value,
    }));
    if (pinned && saved?.node_id) setNodeId(saved.node_id);
  }
  useEffect(() => {
    let live = true;
    api<LearningContinuation[]>("/learning/continuations")
      .then((values) => {
        if (live)
          setContinuations((previous) => {
            const next = Object.fromEntries(
              values.map((item) => [item.goal_id, item]),
            );
            const pin = pinnedSession.current;
            if (pin && previous[pin.goalId]?.session_id === pin.id)
              next[pin.goalId] = previous[pin.goalId];
            return next;
          });
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [goals]);
  useEffect(() => {
    if (goalId)
      void reloadContinuity(goalId).catch((cause: Error) =>
        setError(cause.message),
      );
    // Goal navigation reads saved continuity, never starts teaching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);
  useEffect(
    () => () => {
      const saved = sessionRef.current;
      if (saved?.status === "active")
        void api(`/learning/sessions/${saved.id}/pause`, "POST").catch(
          () => {},
        );
    },
    [],
  );
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest || handledRequest.current === openRequest.key) return;
    handledRequest.current = openRequest.key;
    const requestedGoal = goals.find(
      (value) => value.id === openRequest.goalId,
    );
    if (!requestedGoal) {
      setError("这个学习目标已不存在，请从学习列表选择。");
      setGoalId("");
      setNodeId("");
      onOpenHandled?.();
      return;
    }
    selectGoal(requestedGoal);
    if (openRequest.sessionId) {
      pinnedSession.current = {
        goalId: requestedGoal.id,
        id: openRequest.sessionId,
      };
    }
    void reloadContinuity(requestedGoal.id).catch((cause: Error) =>
      setError(`无法打开原会话：${cause.message}`),
    );
    onOpenHandled?.();
    // Each explicit card activation has its own key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, goals]);
  useEffect(() => {
    if (selectedGoal && !nodeId)
      setNodeId(
        selectedGoal.current_node_id || selectedGoal.nodes[0]?.id || "",
      );
  }, [selectedGoal, nodeId]);
  useEffect(() => {
    let live = true;
    setLesson(null);
    setTurns([]);
    setLearningStream(null);
    if (nodeId)
      Promise.all([
        api<Lesson | null>(
          pinnedLessonId
            ? `/learning/lessons/${pinnedLessonId}`
            : `/learning/nodes/${nodeId}/lesson`,
        ),
        api<LearningTurn[]>(`/learning/nodes/${nodeId}/turns`),
      ])
        .then(([value, history]) => {
          if (live) {
            setLesson(value);
            setTurns(
              pinnedLessonId && session
                ? history.filter(
                    (turn) =>
                      (turn as LearningTurn & { session_id?: string })
                        .session_id === session.id,
                  )
                : history,
            );
          }
        })
        .catch((error) => {
          if (live) setError(error.message);
        });
    return () => {
      live = false;
    };
  }, [nodeId, pinnedLessonId]);
  async function ensureSession(targetNode?: string, minutes?: number) {
    if (!goal) throw new Error("请先选择学习目标。");
    await flushDraft();
    pinnedSession.current = null;
    continuityVersion.current += 1;
    const saved = await api<LearningSession>(
      `/learning/goals/${goal.id}/sessions`,
      "POST",
      {
        node_id: targetNode || nodeId || undefined,
        target_minutes: minutes,
      },
    );
    if (selectedGoalId.current !== saved.goal_id)
      throw new Error("学习目标已经切换，请在当前目标中重新开始。");
    setSession(saved);
    return saved;
  }
  async function changeSession(action: "pause" | "end") {
    const saved = sessionRef.current;
    if (!saved || (busy && action !== "end") || sessionBusy || uploading) return;
    setSessionBusy(true);
    setError("");
    try {
      await flushLearningDrafts();
      const updated = await api<LearningSession>(
        `/learning/sessions/${saved.id}/${action}`,
        "POST",
      );
      if (selectedGoalId.current !== saved.goal_id) return;
      if (action === "end") {
        watch.current?.abort(); setBusy(false); setRun(null); setPendingReply(null); setLearningStream(null); setReviewOpen(false);
      }
      setSession(updated);
      await reloadContinuity(saved.goal_id);
      setNotice(
        action === "end"
          ? "本次学习已结束，课程、练习和草稿已保留。"
          : "已暂停，下次可以接着学。",
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSessionBusy(false);
    }
  }
  async function moveToNode(value: Node) {
    await flushDraft();
    pinnedSession.current = null;
    continuityVersion.current += 1;
    const previous = sessionRef.current;
    if (previous && previous.status !== "ended") {
      const moved = await api<LearningSession>(
        `/learning/sessions/${previous.id}/resume`,
        "POST",
        {
          node_id: value.id,
        },
      );
      const updated =
        previous.status === "paused"
          ? await api<LearningSession>(
              `/learning/sessions/${previous.id}/pause`,
              "POST",
            )
          : moved;
      if (selectedGoalId.current !== previous.goal_id) return;
      setSession(updated);
    }
    setNodeId(value.id);
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 1099px)").matches
    )
      setOutlineOpen(false);
    if (goal) await reloadContinuity(goal.id);
  }
  async function switchNode(value: Node) {
    if (busy || sessionBusy || uploading || nodeId === value.id) return;
    setSessionBusy(true);
    setError("");
    try {
      await moveToNode(value);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSessionBusy(false);
    }
  }
  async function finishSection() {
    if (!node || !lesson || busy || sessionBusy || uploading || finishingSection.current) return;
    finishingSection.current = true;
    const targetGoal = goalId;
    setSessionBusy(true);
    setError("");
    try {
      await flushDraft();
      await api(`/learning/nodes/${node.id}/complete`, "POST");
      await refresh();
      if (selectedGoalId.current !== targetGoal) return;
      if (nextNode) {
        await moveToNode(nextNode);
      } else {
        const currentSession = sessionRef.current;
        if (currentSession && currentSession.status !== "ended") {
          const ended = await api<LearningSession>(
            `/learning/sessions/${currentSession.id}/end`,
            "POST",
          );
          if (selectedGoalId.current !== targetGoal) return;
          setSession(ended);
        }
        await reloadContinuity(targetGoal);
        setGoalId(""); setNodeId(""); setSession(null);
        setNotice("课程已学完，未掌握的内容保留为待复习内容。");
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      finishingSection.current = false;
      setSessionBusy(false);
    }
  }
  async function leaveGoal() {
    const targetGoal = selectedGoalId.current;
    try {
      await flushDraft();
      const previous = sessionRef.current;
      if (previous?.status === "active")
        await api(`/learning/sessions/${previous.id}/pause`, "POST");
    } catch (cause) {
      setError((cause as Error).message);
    }
    if (selectedGoalId.current !== targetGoal) return;
    watch.current?.abort();
    pinnedSession.current = null;
    continuityVersion.current += 1;
    setSession(null);
    setGoalId("");
    setNodeId("");
    setRun(null);
    setBusy(false);
  }
  async function finishRun(
    value: Run,
    signal: AbortSignal,
    targetNode?: string,
  ) {
    if (signal.aborted) return;
    if (value.status === "failed") setError(value.error || "本次执行未完成");
    const target =
      targetNode || String(value.result?.node_id || activeNode.current || "");
    if (target) {
      const [latest, history] = await Promise.all([
        api<Lesson | null>(`/learning/nodes/${target}/lesson`),
        api<LearningTurn[]>(`/learning/nodes/${target}/turns`),
      ]);
      if (signal.aborted) return;
      if (activeNode.current === target) {
        setLesson(latest);
        setTurns(history);
        if (value.status === "completed") {
          setPendingReply(null);
          setLearningStream(null);
        }
        if (value.status === "completed" && value.kind === "assessment") {
          const submitted = submittedDrafts.current.get(value.id);
          if (submitted) clearSubmittedDraft(submitted);
          submittedDrafts.current.delete(value.id);

        }
      }
    }
    const updates = await Promise.allSettled([
      refresh(),
      reloadContinuity(selectedGoalId.current),
    ]);
    if (signal.aborted) return;
    if (updates.some((result) => result.status === "rejected"))
      setError("回复记录已读取，课程或会话状态暂未刷新，请稍后重新进入。");
    setRun(value);
    setBusy(false);
  }
  async function track(value: Run, targetNode?: string) {
    watch.current?.abort();
    stopLock.current = false;
    setStopping(false);
    const controller = new AbortController();
    watch.current = controller;
    setRun(value);
    setBusy(true);
    setLearningStream(null);
    try {
      const result = await readEvents(
        value.id,
        (event) => {
          if (controller.signal.aborted || event.kind !== "learning_content")
            return;
          const target = String(event.data.node_id || "");
          if (target !== activeNode.current) return;
          setLearningStream({
            nodeId: target,
            stage: String(event.data.stage),
            fields: event.data.fields as Record<string, string>,
          });
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        await finishRun(result, controller.signal, targetNode);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError((error as Error).message);
        setBusy(false);
      }
    }
  }
  async function stopLearning() {
    if (!run || stopLock.current) return;
    const targetGoal = goalId;
    const controller = watch.current;
    const isCurrent = () =>
      selectedGoalId.current === targetGoal &&
      watch.current === controller &&
      !controller?.signal.aborted;
    stopLock.current = true;
    setStopping(true);
    setError("");
    try {
      const stopped = await api<Run>(`/runs/${run.id}/cancel`, "POST");
      if (!isCurrent()) return;
      controller?.abort();
      watch.current = null;
      stopLock.current = false;
      setStopping(false);
      setRun(stopped);
      setBusy(false);
      void refresh().catch(() => {
        if (selectedGoalId.current === targetGoal)
          setError("学习任务已停止，进度暂未刷新，请重新进入学习页查看。");
      });
    } catch (error) {
      if (isCurrent()) setError(`停止失败：${(error as Error).message}`);
    } finally {
      if (isCurrent()) {
        stopLock.current = false;
        setStopping(false);
      }
    }
  }
  useEffect(() => {
    let live = true;
    if (goalId)
      api<Run[]>(`/runs?goal_id=${goalId}`)
        .then((values) => {
          if (!live) return;
          const active = values.find((x) =>
            ["queued", "running"].includes(x.status),
          );
          if (active && !["learning_review", "review_assessment"].includes(active.kind)) void track(active, nodeId || undefined);
        })
        .catch(() => {});
    return () => {
      live = false;
      watch.current?.abort();
    };
    // Track is intentionally scoped to a selected goal; API completion reads fresh data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const editing = editingGoalId;
      const value = await api<Goal>(
        editing ? `/learning/goals/${editing}` : "/learning/goals",
        editing ? "PUT" : "POST",
        {
          title,
          objective,
          foundation,
          use_beginner_defaults: useBeginnerDefaults,
          outcome,
          weekly_minutes: weeklyMinutes.trim() ? Number(weeklyMinutes) : null,
          target_date: targetDate || null,
        },
      );
      await refresh();
      setOpen(false);
      if (editing) {
        setNotice("学习目标已更新，已有课程、练习和会话继续保留。");
        setBusy(false);
        await reloadContinuity(editing);
        return;
      }
      selectGoal(value);
      setTitle("");
      setObjective("");
      setFoundation("");
      setUseBeginnerDefaults(false);
      const next = await api<Run>(`/learning/goals/${value.id}/plan`, "POST");
      void track(next);
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  async function plan() {
    if (!goal || busy) return;
    setError("");
    setBusy(true);
    try {
      void track(await api<Run>(`/learning/goals/${goal.id}/plan`, "POST"));
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  async function teach(value: Node) {
    if (busy || sessionBusy) return;
    setBusy(true);
    setNodeId(value.id);
    setError("");
    try {
      void track(
        await api<Run>(`/learning/nodes/${value.id}/lesson`, "POST", {
          session_id: (await ensureSession(value.id)).id,
        }),
        value.id,
      );
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  async function submit() {
    if (!lesson || !node || busy || sessionBusy || uploading) return;
    const submittedAnswer = answer;
    const submittedImages = images;
    setError("");
    followReply.current = true;
    setPendingReply({
      nodeId: node.id,
      answer: submittedAnswer,
      attachmentIds: submittedImages.map((item) => item.id),
    });
    setLearningStream(null);
    setBusy(true);
    try {
      const saved = await ensureSession(node.id);
      const value = await api<Run>(
        `/learning/lessons/${lesson.id}/submit`,
        "POST",
        {
          submission_id: crypto.randomUUID(),
          answer: submittedAnswer,
          attachment_ids: submittedImages.map((x) => x.id),
          session_id: saved.id,
        },
      );
      submittedDrafts.current.set(value.id, {
        nodeId: node.id,
        lessonId: lesson.id,
        answer: submittedAnswer,
        attachment_ids: submittedImages.map((item) => item.id),
      });
      void track(value, node.id);
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
      setPendingReply(null);
    }
  }
  async function reviewReminder() {
    if (!node || reviewReminderLock.current) return;
    reviewReminderLock.current = true;
    try {
      await api("/reminders", "POST", {
        title: `复习：${node.title}`,
        body: `学习主题：${goal?.title}`,
        due_at: new Date(Date.now() + 86400000).toISOString(),
        timezone: "Asia/Shanghai",
        recurrence: "none",
      });
      setError("");
      await refresh().catch(() =>
        setError("复习提醒已创建，列表暂未刷新，请稍后查看日历。"),
      );
      setNotice("已创建明天同一时间的复习提醒，可在提醒页调整。");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      reviewReminderLock.current = false;
    }
  }
  const feedback = lesson?.feedback as
    | {
        passed?: boolean;
        explanation?: string;
        strengths?: string[];
        gaps?: string[];
        next_step?: string;
        evidence?: string;
      }
    | undefined;
  const weeklyMinutesInvalid =
    Boolean(weeklyMinutes.trim()) &&
    (!/^\d+$/.test(weeklyMinutes.trim()) ||
      Number(weeklyMinutes) < 1 ||
      Number(weeklyMinutes) > 10080);
  const lessonMaterial = lesson ? (
    <>
      {" "}
      <Markdown>{lesson.content}</Markdown>
      <section className="exercise-box">
        <div className="section-title">
          <FileQuestion size={20} />
          <div>
            <h2>现在轮到你试一试</h2>
          </div>
        </div>
        <Markdown numberedLists>{lesson.exercise}</Markdown>
        {lesson.hints.length > 0 && (
          <div className="lesson-hint-entry">
            <div>
              <Lightbulb size={18} />
              <span>
                <strong>需要一点思路？</strong>
                <small>先看提示，再试着自己回答。</small>
              </span>
            </div>
            <DetailDialog
              title="练习提示"
              label="查看提示"
              description="这些思路帮助你开始，不会替代你的实际回答。"
            >
              <ol className="lesson-hint-steps">
                {lesson.hints.map((hint, index) => (
                  <li key={index}>
                    <Markdown>{hint}</Markdown>
                  </li>
                ))}
              </ol>
            </DetailDialog>
          </div>
        )}
      </section>{" "}
    </>
  ) : null;
  const studiedCount =
    goal?.nodes.filter((value) => isStudied(value.status)).length ?? 0;
  return (
    <div
      className={`learning-page ${open ? "is-editing" : goal ? "has-course" : "page-content"}`}
    >
      {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      {error && (
        <Toast tone="error" message={error} onClose={() => setError("")} />
      )}
      {open && !editingGoalId ? (
        <LearningIntakePage onBack={() => setOpen(false)} onCreated={async (id) => {
          const value = await api<Goal>(`/learning/goals/${id}`); await refresh(); setOpen(false); selectGoal(value);
        }} />
      ) : open ? (
        <CreationPage
          className="learning-goal-creation"
          footerNote="填写主题与基础即可开始，时间安排之后也能调整。"
          title={editingGoalId ? "调整学习目标" : "你想学什么？"}
          description={
            editingGoalId
              ? "调整接下来的方向，已有课程与学习记录会继续保留。"
              : "告诉 XiaoXi 你想做成什么，从适合你的一小步开始。"
          }
          backLabel={goal ? "返回课程" : "返回学习"}
          onBack={() => setOpen(false)}
          busy={busy}
          actions={
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                disabled={
                  !title.trim() ||
                  busy ||
                  weeklyMinutesInvalid ||
                  (!useBeginnerDefaults &&
                    (!objective.trim() || !foundation.trim()))
                }
                onClick={() => void create()}
              >
                <Sparkles size={15} />
                {busy
                  ? "正在保存…"
                  : editingGoalId
                    ? "保存目标"
                    : "建立学习路线"}
              </Button>
            </>
          }
        >
          {error && <ErrorNotice message={error} />}
          <div className="learning-goal-form">
            <section
              className="learning-goal-main"
              aria-labelledby="goal-direction-heading"
            >
              <header className="goal-form-section-heading">
                <span>01</span>
                <div>
                  <h2 id="goal-direction-heading">学习方向</h2>
                  <p>你想做成什么，现在从哪里开始。</p>
                </div>
              </header>
              <div className="form-field">
                <Label htmlFor="goal-title">想学什么</Label>
                <Input
                  id="goal-title"
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="描述你想掌握的知识或技能"
                />
              </div>
              <div className="form-field">
                <Label htmlFor="goal-objective">希望学会后能做什么</Label>
                <Textarea
                  id="goal-objective"
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                  rows={3}
                  placeholder="描述学会后希望具备的能力"
                />
              </div>
              <div className="form-field">
                <Label htmlFor="goal-foundation">目前的基础</Label>
                <Textarea
                  id="goal-foundation"
                  value={foundation}
                  onChange={(event) => setFoundation(event.target.value)}
                  rows={3}
                  placeholder="说说已有经验，以及还不熟悉的地方"
                />
              </div>
              <button
                type="button"
                className={`learning-default-choice ${useBeginnerDefaults ? "is-selected" : ""}`}
                aria-pressed={useBeginnerDefaults}
                onClick={() => setUseBeginnerDefaults((value) => !value)}
              >
                <span className="learning-choice-indicator">
                  {useBeginnerDefaults && <Check size={14} />}
                </span>
                <span>
                  <strong>还不确定？先按零基础安排</strong>
                  <small>未填写的目标与基础由 XiaoXi 按入门方向补充。</small>
                </span>
              </button>
            </section>
            <aside
              className="learning-goal-preferences"
              aria-labelledby="goal-pace-heading"
            >
              <header className="goal-form-section-heading">
                <span>02</span>
                <div>
                  <h2 id="goal-pace-heading">按你的节奏</h2>
                  <p>以下可选，之后也可以调整。</p>
                </div>
              </header>
              <div className="form-field">
                <Label htmlFor="goal-outcome">想完成的小成果</Label>
                <Textarea
                  id="goal-outcome"
                  rows={3}
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value)}
                  placeholder="描述你希望完成的一项小成果"
                />
              </div>
              <div className="form-field">
                <Label htmlFor="goal-weekly-minutes">每周愿意投入多久</Label>
                <div className="goal-time-input">
                  <Input
                    id="goal-weekly-minutes"
                    type="text"
                    inputMode="numeric"
                    maxLength={5}
                    value={weeklyMinutes}
                    onChange={(event) => setWeeklyMinutes(event.target.value)}
                    placeholder="120"
                    aria-describedby={
                      weeklyMinutesInvalid
                        ? "goal-time-error"
                        : "goal-time-unit"
                    }
                    aria-invalid={weeklyMinutesInvalid}
                  />
                  <span id="goal-time-unit">分钟 / 周</span>
                </div>
                {weeklyMinutesInvalid && (
                  <p className="goal-field-error" id="goal-time-error">
                    请填写 1 至 10080 的整数分钟，或留空。
                  </p>
                )}
              </div>
              <div className="form-field">
                <Label htmlFor="goal-target-date">希望什么时候达成</Label>
                <DateTimePicker
                  id="goal-target-date"
                  dateOnly
                  label="目标日期"
                  value={targetDate}
                  onChange={setTargetDate}
                />
                {targetDate && (
                  <button
                    type="button"
                    className="text-button goal-clear-date"
                    onClick={() => setTargetDate("")}
                  >
                    清除日期
                  </button>
                )}
              </div>
            </aside>
          </div>
        </CreationPage>
      ) : !goal ? (
        <>
          <div className="page-heading">
            <div>
              <h1>学习</h1>
            </div>
            <Button onClick={() => openGoalEditor()}>
              <Plus size={16} />
              新的学习目标
            </Button>
          </div>
          {availableGoals.length ? (
            <div className="goal-list">
              {availableGoals.map((value) => {
                const passed = value.nodes.filter(
                  (x) => x.status === "passed",
                ).length;
                const studied = value.nodes.filter((x) =>
                  isStudied(x.status),
                ).length;
                return (
                  <article className="goal-card-row" key={value.id}>
                    <button
                      className="goal-card-main"
                      onClick={() => selectGoal(value)}
                    >
                      <span className="goal-row-icon">
                        <BookOpen size={22} />
                      </span>
                      <span className="goal-row-content">
                        <strong>{value.title}</strong>
                        <span>
                          {value.objective || "从基础入门，逐步完成实际练习。"}
                        </span>
                        <small>
                          {value.nodes.find(
                            (node) => node.id === value.current_node_id,
                          )?.title || "建立你的知识框架"}
                        </small>
                        {continuations[value.id] && (
                          <span className="goal-continuation-summary">
                            <span>
                              上次学习：
                              {learningDate(
                                continuations[value.id].last_studied_at,
                              )}
                            </span>
                            {continuations[value.id].gaps.length > 0 && (
                              <span>
                                当前卡点：
                                {continuations[value.id].gaps.join("；")}
                              </span>
                            )}
                            <span>
                              下一步：{continuations[value.id].next_step}
                            </span>
                          </span>
                        )}
                      </span>
                    </button>
                    <div className="goal-row-progress">
                      <span>
                        {value.nodes.length
                          ? `进度 ${studied} / ${value.nodes.length} · ${passed} 练习通过`
                          : "等待规划"}
                      </span>
                      <div
                        className="progress-track"
                        role="progressbar"
                        aria-label={`${value.title} 的学习进度`}
                        aria-valuenow={studied}
                        aria-valuemin={0}
                        aria-valuemax={Math.max(1, value.nodes.length)}
                      >
                        <span
                          style={{
                            width: `${value.nodes.length ? (studied / value.nodes.length) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="goal-row-actions">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`编辑学习目标 ${value.title}`}
                        onClick={() => openGoalEditor(value)}
                      >
                        <Settings2 size={15} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => selectGoal(value)}
                      >
                        继续学习
                        <ArrowRight size={15} />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`删除学习目标 ${value.title}`}
                        onClick={() => {
                          setError("");
                          setDeleting(value);
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <>
              <div className="learning-intro">
                <div className="learning-orbit">
                  <GraduationCap size={43} />
                  <span />
                  <span />
                </div>
                <h2>你想学的，都可以从这里开始。</h2>
                <p>
                  从你想掌握的知识或技能开始。
                  <br />
                  告诉XiaoXi你的目标与基础，它会陪你一步一步学。
                </p>
                <Button onClick={() => openGoalEditor()}>
                  <Plus size={16} />
                  建立第一个学习目标
                </Button>
              </div>
              <div className="learning-method">
                <div>
                  <Compass size={21} />
                  <h3>先有框架</h3>
                  <p>看清知识全貌和学习顺序。</p>
                </div>
                <div>
                  <Target size={21} />
                  <h3>每次一小步</h3>
                  <p>讲解、示例、练习和具体反馈。</p>
                </div>
                <div>
                  <RotateCcw size={21} />
                  <h3>接着上次学</h3>
                  <p>保存进度，回补没掌握的地方。</p>
                </div>
              </div>
            </>
          )}
        </>
      ) : (
        <div className="course-layout">
          <header
            className="course-header course-header-compact"
            aria-label={goal.title}
          >
            <div className="course-heading">
              <button className="back-link" onClick={() => void leaveGoal()}>
                <ArrowLeft size={15} />
                所有学习目标
              </button>
            </div>
            <LearningSessionPanel
              goal={goal}
              session={session}
              busy={busy || sessionBusy || uploading || reviewBusy}
              ending={sessionBusy}
              onReview={() => { void flushDraft().then(() => setReviewOpen(true)).catch((cause: Error) => setError(cause.message)); }}
              onPause={() => void changeSession("pause")}
              onEnd={() => void changeSession("end")}
              onComplete={node && lesson && !reviewOpen ? () => void finishSection() : undefined}
              onEdit={() => openGoalEditor(goal)}
              onReviewReminder={
                node && lesson ? () => void reviewReminder() : undefined
              }
            />
            <div className="course-progress">
              <span>
                进度 <strong>{studiedCount}</strong> / {goal.nodes.length}

              </span>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="课程学习进度"
                aria-valuenow={studiedCount}
                aria-valuemin={0}
                aria-valuemax={Math.max(1, goal.nodes.length)}
              >
                <span
                  style={{
                    width: `${goal.nodes.length ? (studiedCount / goal.nodes.length) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          </header>
          <div
            className={`course-body ${outlineOpen ? "outline-open" : "outline-closed"}`}
          >
            <aside
              className="course-outline"
              id="course-outline"
              aria-label="课程目录"
              hidden={!outlineOpen}
            >
              <div className="outline-heading">
                课程目录<span>{goal.nodes.length} 节</span>
              </div>
              <div className="outline-items">
                {goal.nodes.map((value, i) => (
                  <div key={value.id}>
                    {i === 0 || goal.nodes[i - 1].module !== value.module ? (
                      <p className="module-label">{value.module}</p>
                    ) : null}
                    <button
                      className={`outline-node ${nodeId === value.id ? "active" : ""}`}
                      aria-current={nodeId === value.id ? "step" : undefined}
                      disabled={busy || sessionBusy || reviewBusy}
                      onClick={() => { setReviewOpen(false); void switchNode(value); }}
                    >
                      <span title={nodeStatus[value.status]} className={`node-symbol ${value.status}`}>
                        <span className="sr-only">{nodeStatus[value.status]}</span>
                        {value.status === "passed" ? (
                          <Check size={13} />
                        ) : value.status === "skipped" ? (
                          <SkipForward size={12} />
                        ) : (
                          String(i + 1).padStart(2, "0")
                        )}
                      </span>
                      <span>
                        {value.title}

                      </span>
                    </button>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="delete-course"
                onClick={() => setDeleting(goal)}
              >
                <Trash2 size={14} />
                删除学习目标
              </Button>
            </aside>
            {reviewOpen && <LearningReviewPanel goalId={goal.id} onBack={() => setReviewOpen(false)} refresh={async () => { await refresh(); await reloadContinuity(goal.id); }} onBusy={setReviewBusy} />}
            <div className="lesson-content" ref={answerDropTarget} hidden={reviewOpen}>
              <div
                className="lesson-scroll"
                ref={lessonScroll}
                onScroll={(event) => {
                  const viewport = event.currentTarget;
                  followReply.current =
                    viewport.scrollHeight -
                      viewport.scrollTop -
                      viewport.clientHeight <
                    96;
                }}
              >
                <div className="lesson-inner">
                  {draftConflict && (
                    <div className="learning-draft-conflict" role="alert">
                      <p>
                        会话草稿已在另一个操作中更新。当前输入仍保留，请选择继续使用哪一份。
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void resolveDraftConflict("remote")}
                      >
                        使用会话中的草稿
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void resolveDraftConflict("local")}
                      >
                        保留本机并覆盖会话草稿
                      </Button>
                    </div>
                  )}
                  <div className="lesson-topline">
                    <div className="lesson-location">
                      <span>{node?.module || "课程规划"}</span>
                      {node && (
                        <span className={`small-label ${node.status}`}>
                          {nodeStatus[node.status]}
                        </span>
                      )}
                    </div>
                    {busy && (
                      <span className="working-label">
                        <Loader2 size={14} className="spin" />
                        {run?.kind === "course"
                          ? "正在建立知识框架"
                          : run?.kind === "assessment"
                            ? "正在分析中，请稍后…"
                            : "正在准备教学"}
                        <button
                          disabled={!run || stopping}
                          onClick={() => void stopLearning()}
                        >
                          {stopping ? "正在停止…" : "停止"}
                        </button>
                      </span>
                    )}
                  </div>
                  {!goal.nodes.length ? (
                    <EmptyState
                      icon={Compass}
                      title="准备你的学习路线"
                      action={
                        <div className="empty-actions">
                          <Button onClick={() => void plan()} disabled={busy}>
                            <Sparkles size={15} />
                            生成知识框架
                          </Button>
                          <Button variant="ghost" onClick={onSettings}>
                            检查模型设置
                          </Button>
                        </div>
                      }
                    >
                      XiaoXi将根据你的目标与基础，规划模块、知识点和练习。
                    </EmptyState>
                  ) : node ? (
                    <>
                      <div className="lesson-heading">
                        <h1>{node.title}</h1>
                        <p>{node.objective}</p>
                      </div>
                      {node.prerequisites.length > 0 && (
                        <div className="prerequisite-line">
                          前置知识：
                          {node.prerequisites
                            .map(
                              (id) =>
                                goal.nodes.find((x) => x.id === id)?.title,
                            )
                            .filter(Boolean)
                            .join("、")}
                        </div>
                      )}
                      {learningStream?.nodeId === nodeId &&
                        learningStream.stage === "lesson" &&
                        (busy ||
                          run?.status === "failed" ||
                          run?.status === "cancelled") && (
                          <section
                            className="lesson-stream"
                            aria-label="学习内容生成进度"
                            aria-busy={busy}
                          >
                            <Markdown>
                              {learningStream.fields.content ||
                                learningStream.fields.explanation ||
                                ""}
                            </Markdown>
                            {learningStream.fields.exercise && (
                              <>
                                <h2>现在轮到你试一试</h2>
                                <Markdown numberedLists>
                                  {learningStream.fields.exercise}
                                </Markdown>
                              </>
                            )}
                            {learningStream.fields.next_step && (
                              <Markdown>
                                {learningStream.fields.next_step}
                              </Markdown>
                            )}
                            <p className="muted">
                              {busy
                                ? "正在继续生成…"
                                : "本次生成未完成，以上内容尚未保存为正式教学。"}
                            </p>
                          </section>
                        )}
                      {lesson &&
                      !(busy && learningStream?.stage === "lesson") ? (
                        <>
                          <article id="learning-original-lesson" className="learning-original-lesson">
                            <span className="message-name">XiaoXi</span>{lessonMaterial}
                          </article>
                          {turns.length > 0 && <button className="text-button learning-return-to-lesson" onClick={() => lessonScroll.current?.scrollTo({ top: 0, behavior: "smooth" })}>回看讲解与原练习</button>}

                          <LearningConversation
                            turns={turns}
                            fallback={feedback}
                          />
                          {(pendingReply?.nodeId === nodeId ||
                            learningStream?.stage === "assessment") && (
                            <LearningPendingReply
                              answer={pendingReply?.answer}
                              attachmentIds={pendingReply?.attachmentIds || []}
                              fields={
                                learningStream?.stage === "assessment"
                                  ? learningStream.fields
                                  : {}
                              }
                              busy={busy}
                            />
                          )}
                        </>
                      ) : busy &&
                        learningStream?.stage === "lesson" &&
                        learningStream.fields.content ? null : (
                        <div className="start-lesson">
                          {busy ? (
                            <div
                              className="lesson-loading"
                              role="status"
                              aria-label="正在准备教学"
                            >
                              <div className="lesson-loading-avatar">
                                <BaiAvatar motion="thinking" />
                              </div>
                              <div
                                className="lesson-skeleton"
                                aria-hidden="true"
                              >
                                <span />
                                <span />
                                <span />
                              </div>
                            </div>
                          ) : (
                            <Button
                              disabled={busy}
                              onClick={() => void teach(node)}
                            >
                              <BookOpen size={17} />
                              开始这个知识点
                            </Button>
                          )}
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              </div>
              {node &&
                lesson &&
                ["awaiting_submission", "reviewed"].includes(lesson.state) && (
                  <LearningComposer answer={answer} onAnswer={setAnswer} images={images} onImages={setImages}
                    busy={busy || sessionBusy} uploading={uploading} onUploading={setUploading}
                    onError={setError} onSubmit={() => void submit()} scopeKey={lesson.id} />
                )}
            </div>
          </div>
        </div>
      )}
      <ConfirmDelete
        open={Boolean(deleting)}
        title="删除这个学习目标？"
        description={
          deleting?.active_run_id
            ? "将先停止正在执行的学习任务，再删除课程、练习和进度。"
            : "课程、练习和进度会一起删除。"
        }
        label={deleting?.active_run_id ? "停止任务并删除" : "删除目标"}
        error={error}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            const result = await api<{ cleanup_pending?: number }>(
              `/learning/goals/${deleting.id}?stop=${Boolean(deleting.active_run_id)}`,
              "DELETE",
            );
            if (goalId === deleting.id) watch.current?.abort();
            setError("");
            clearLearningGoalDrafts(deleting.nodes.map((node) => node.id));
            setRemovedGoalIds((ids) => new Set([...ids, deleting.id]));
            setDeleting(null);
            if (goalId === deleting.id) {
              setGoalId("");
              setNodeId("");
              setLesson(null);
              setSession(null);
              setRun(null);
              setBusy(false);
            }
            if (result.cleanup_pending)
              setNotice("学习目标已删除，部分本机文件或执行缓存清理未完成。");
            await refresh().catch(() =>
              setNotice("学习目标已删除，部分列表暂未刷新，请稍后刷新查看。"),
            );
          } catch (error) {
            setError((error as Error).message);
            void api<Goal>(`/learning/goals/${deleting.id}`)
              .then(setDeleting)
              .catch(() => {});
            void refresh();
          }
        }}
      />
    </div>
  );
}
