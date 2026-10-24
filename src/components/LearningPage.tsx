import { useEffect, useState, useRef } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ArrowUp,
  Compass,
  FileQuestion,
  GraduationCap,
  Loader2,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { type LearningContinuation, type LearningGoalDetails, type LearningSession, learningDate } from "@/lib/learningSessions";
import {
  EmptyState,
  ErrorNotice,
  ImagesInput,
  Markdown,
  nodeStatus,
  ConfirmDelete,
  Toast,
  Hint,
} from "./common";
import { BaiAvatar } from "./BaiAvatar";
import { LearningConversation } from "./LearningConversation";
import { LearningSessionPanel } from "./LearningSessionPanel";

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
  const selectedGoalId = useRef(goalId);
  selectedGoalId.current = goalId;
  const [run, setRun] = useState<Run | null>(null);
  const [session, setSession] = useState<LearningSession | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [sessionBusy, setSessionBusy] = useState(false);
  const [continuations, setContinuations] = useState<Record<string, LearningContinuation>>({});
  const submittedDrafts = useRef(new Map<string, { nodeId: string; lessonId: string; answer: string; attachment_ids: string[] }>());
  const pinnedSession = useRef<{ goalId: string; id: string } | null>(null);
  const continuityVersion = useRef(0);
  const [learningStream, setLearningStream] = useState<{
    nodeId: string;
    stage: string;
    fields: Record<string, string>;
  } | null>(null);
  const { answer, setAnswer, images, setImages, saving: savingDraft, flush: flushDraft, clearIfUnchanged: clearSubmittedDraft, conflict: draftConflict, resolveConflict: resolveDraftConflict } = useLearningDraft(
    nodeId,
    lesson,
    { session, onError: setError },
  );
  const [hints, setHints] = useState(false);
  const [answerExpanded, setAnswerExpanded] = useState(false);
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
  const answerDropTarget = useRef<HTMLDivElement>(null);
  const answerPreviewTarget = useRef<HTMLDivElement>(null);
  const watch = useRef<AbortController | null>(null);
  const activeNode = useRef(nodeId);
  activeNode.current = nodeId;
  const selectedGoal = availableGoals.find((x) => x.id === goalId);
  const goal = selectedGoal || null;
  const node = goal?.nodes.find((x) => x.id === nodeId);
  const pinnedLessonId = session?.id === pinnedSession.current?.id && session?.node_id === nodeId ? session?.lesson_id : null;
  function selectGoal(value: Goal) {
    pinnedSession.current = null;
    continuityVersion.current += 1;
    const previous = sessionRef.current;
    if (previous?.status === "active")
      void api(`/learning/sessions/${previous.id}/pause`, "POST").catch((cause: Error) => setError(cause.message));
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
  async function reloadContinuity(targetGoal = selectedGoalId.current) {
    if (!targetGoal) return;
    const request = ++continuityVersion.current;
    const value = await api<LearningContinuation>(`/learning/goals/${targetGoal}/continuation`);
    const pinned = pinnedSession.current?.goalId === targetGoal ? pinnedSession.current.id : null;
    const id = pinned || value.session_id;
    const saved = id ? await api<LearningSession>(`/learning/sessions/${id}`) : null;
    if (request !== continuityVersion.current || selectedGoalId.current !== targetGoal) return;
    if (saved && saved.goal_id !== targetGoal) throw new Error("接续卡与学习目标不一致，请从学习列表继续。");
    setSession(saved);
    const nodeTitle = goals.find((item) => item.id === targetGoal)?.nodes.find((item) => item.id === saved?.node_id)?.title || "";
    setContinuations((previous) => ({ ...previous, [targetGoal]: pinned && saved ? {
      ...value, session_id: saved.id, node_id: saved.node_id, node_title: nodeTitle, lesson_id: saved.lesson_id,
      status: saved.status, summary: saved.summary, gaps: saved.gaps, next_step: saved.next_step,
      last_studied_at: saved.last_studied_at,
    } : value }));
    if (pinned && saved?.node_id) setNodeId(saved.node_id);
  }
  useEffect(() => {
    let live = true;
    api<LearningContinuation[]>("/learning/continuations").then((values) => {
      if (live) setContinuations((previous) => {
        const next = Object.fromEntries(values.map((item) => [item.goal_id, item]));
        const pin = pinnedSession.current;
        if (pin && previous[pin.goalId]?.session_id === pin.id) next[pin.goalId] = previous[pin.goalId];
        return next;
      });
    }).catch((cause: Error) => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [goals]);
  useEffect(() => {
    if (goalId) void reloadContinuity(goalId).catch((cause: Error) => setError(cause.message));
    // Goal navigation reads saved continuity, never starts teaching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);
  useEffect(() => () => {
    const saved = sessionRef.current;
    if (saved?.status === "active") void api(`/learning/sessions/${saved.id}/pause`, "POST").catch(() => {});
  }, []);
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest || handledRequest.current === openRequest.key) return;
    handledRequest.current = openRequest.key;
    const requestedGoal = goals.find((value) => value.id === openRequest.goalId);
    if (!requestedGoal) {
      setError("这个学习目标已不存在，请从学习列表选择。");
      setGoalId(""); setNodeId(""); onOpenHandled?.();
      return;
    }
    selectGoal(requestedGoal);
    if (openRequest.sessionId) {
      pinnedSession.current = { goalId: requestedGoal.id, id: openRequest.sessionId };
    }
    void reloadContinuity(requestedGoal.id).catch((cause: Error) => setError(`无法打开原会话：${cause.message}`));
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
    setAnswerExpanded(false);
    setLearningStream(null);
    setHints(false);
    if (nodeId)
      Promise.all([
        api<Lesson | null>(pinnedLessonId ? `/learning/lessons/${pinnedLessonId}` : `/learning/nodes/${nodeId}/lesson`),
        api<LearningTurn[]>(`/learning/nodes/${nodeId}/turns`),
      ])
        .then(([value, history]) => {
          if (live) {
            setLesson(value);
            setTurns(pinnedLessonId && session ? history.filter((turn) => (turn as LearningTurn & { session_id?: string }).session_id === session.id) : history);
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
    const saved = await api<LearningSession>(`/learning/goals/${goal.id}/sessions`, "POST", {
      node_id: targetNode || nodeId || undefined, target_minutes: minutes,
    });
    if (selectedGoalId.current !== saved.goal_id) throw new Error("学习目标已经切换，请在当前目标中重新开始。");
    setSession(saved);
    return saved;
  }
  async function beginSession(minutes?: number) {
    if (!goal || busy || sessionBusy) return;
    setSessionBusy(true); setError("");
    try {
      const saved = await ensureSession(nodeId || undefined, minutes);
      await reloadContinuity(goal.id);
      if (selectedGoalId.current !== goal.id) return;
      if (!saved.node_id) {
        const next = await api<Run>(`/learning/goals/${goal.id}/plan`, "POST");
        void track(next);
      } else {
        setNodeId(saved.node_id);
        const existing = await api<Lesson | null>(`/learning/nodes/${saved.node_id}/lesson`);
        if (existing) { setLesson(existing); setAnswerExpanded(true); }
        else {
          const next = await api<Run>(`/learning/nodes/${saved.node_id}/lesson`, "POST", { session_id: saved.id });
          void track(next, saved.node_id);
        }
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { setSessionBusy(false); }
  }
  async function changeSession(action: "pause" | "end") {
    const saved = sessionRef.current;
    if (!saved || busy || sessionBusy || uploading) return;
    setSessionBusy(true); setError("");
    try {
      await flushDraft();
      const updated = await api<LearningSession>(`/learning/sessions/${saved.id}/${action}`, "POST");
      if (selectedGoalId.current !== saved.goal_id) return;
      setSession(updated);
      await reloadContinuity(saved.goal_id);
      setNotice(action === "end" ? "本次学习已结束，课程、练习和草稿已保留。" : "已暂停，下次可以接着学。");
    } catch (cause) { setError((cause as Error).message); }
    finally { setSessionBusy(false); }
  }
  async function switchNode(value: Node) {
    if (busy || sessionBusy || uploading || nodeId === value.id) return;
    setSessionBusy(true); setError("");
    try {
      await flushDraft();
      const previous = sessionRef.current;
      if (previous && previous.status !== "ended") {
        await api(`/learning/sessions/${previous.id}/pause`, "POST");
        await api(`/learning/sessions/${previous.id}/resume`, "POST", { node_id: value.id });
        const paused = await api<LearningSession>(`/learning/sessions/${previous.id}/pause`, "POST");
        if (selectedGoalId.current !== previous.goal_id) return;
        setSession(paused);
      }
      setNodeId(value.id);
      if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1099px)").matches)
        setOutlineOpen(false);
      if (goal) await reloadContinuity(goal.id);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSessionBusy(false); }
  }
  async function leaveGoal() {
    const targetGoal = selectedGoalId.current;
    try {
      await flushDraft();
      const previous = sessionRef.current;
      if (previous?.status === "active") await api(`/learning/sessions/${previous.id}/pause`, "POST");
    } catch (cause) { setError((cause as Error).message); }
    if (selectedGoalId.current !== targetGoal) return;
    watch.current?.abort();
    pinnedSession.current = null;
    continuityVersion.current += 1;
    setSession(null); setGoalId(""); setNodeId(""); setRun(null); setBusy(false);
  }
  async function finishRun(
    value: Run,
    signal: AbortSignal,
    targetNode?: string,
  ) {
    await refresh();
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
        if (value.status === "completed" && value.kind === "assessment") {
          const submitted = submittedDrafts.current.get(value.id);
          if (submitted) clearSubmittedDraft(submitted);
          submittedDrafts.current.delete(value.id);
          setAnswerExpanded(true);
        }
      }
    }
    await reloadContinuity(selectedGoalId.current);
    if (signal.aborted) return;
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
      setRun(stopped);
      setBusy(false);
      setLearningStream(null);
      void refresh().catch(() => {
        if (isCurrent())
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
          if (active) void track(active, nodeId || undefined);
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
      const value = await api<Goal>(editing ? `/learning/goals/${editing}` : "/learning/goals", editing ? "PUT" : "POST", {
        title,
        objective,
        foundation,
        use_beginner_defaults: useBeginnerDefaults,
        outcome,
        weekly_minutes: weeklyMinutes ? Number(weeklyMinutes) : null,
        target_date: targetDate || null,
      });
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
        await api<Run>(`/learning/nodes/${value.id}/lesson`, "POST", { session_id: (await ensureSession(value.id)).id }),
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
      submittedDrafts.current.set(value.id, { nodeId: node.id, lessonId: lesson.id,
        answer: submittedAnswer, attachment_ids: submittedImages.map((item) => item.id) });
      void track(value, node.id);
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  async function reviewReminder() {
    if (!node) return;
    try {
      await api("/reminders", "POST", {
        title: `复习：${node.title}`,
        body: `学习主题：${goal?.title}`,
        due_at: new Date(Date.now() + 86400000).toISOString(),
        timezone: "Asia/Shanghai",
        recurrence: "none",
      });
      await refresh();
      setError("");
      setNotice("已创建明天同一时间的复习提醒，可在提醒页调整。");
    } catch (cause) {
      setError((cause as Error).message);
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
  const passedCount =
    goal?.nodes.filter((value) => value.status === "passed").length ?? 0;
  return (
    <div className={`learning-page ${goal ? "has-course" : "page-content"}`}>
      {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      {error && (
        <Toast tone="error" message={error} onClose={() => setError("")} />
      )}
      {!goal ? (
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
                        {continuations[value.id] && <span className="goal-continuation-summary">
                          <span>上次学习：{learningDate(continuations[value.id].last_studied_at)}</span>
                          {continuations[value.id].gaps.length > 0 && <span>当前卡点：{continuations[value.id].gaps.join("；")}</span>}
                          <span>下一步：{continuations[value.id].next_step}</span>
                        </span>}
                      </span>
                    </button>
                    <div className="goal-row-progress">
                      <span>
                        {value.nodes.length
                          ? `${passed} / ${value.nodes.length} 练习通过`
                          : "等待规划"}
                      </span>
                      <div
                        className="progress-track"
                        role="progressbar"
                        aria-label={`${value.title} 的练习进度`}
                        aria-valuenow={passed}
                        aria-valuemin={0}
                        aria-valuemax={Math.max(1, value.nodes.length)}
                      >
                        <span
                          style={{
                            width: `${value.nodes.length ? (passed / value.nodes.length) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="goal-row-actions">
                      <Button size="icon" variant="ghost" aria-label={`编辑学习目标 ${value.title}`} onClick={() => openGoalEditor(value)}><Settings2 size={15} /></Button>
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
                  做饭、养猫、游戏、编程……
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
              <button
                className="back-link"
                onClick={() => void leaveGoal()}
              >
                <ArrowLeft size={15} />
                所有学习目标
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="outline-toggle"
                aria-label={outlineOpen ? "收起课程目录" : "展开课程目录"}
                aria-expanded={outlineOpen}
                aria-controls="course-outline"
                onClick={() => setOutlineOpen(!outlineOpen)}
              >
                {outlineOpen ? (
                  <PanelLeftClose size={17} />
                ) : (
                  <PanelLeftOpen size={17} />
                )}
                <span>目录</span>
              </Button>
            </div>
            <div className="course-progress">
              <span>
                <strong>{passedCount}</strong> / {goal.nodes.length} 练习通过
              </span>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="课程练习进度"
                aria-valuenow={passedCount}
                aria-valuemin={0}
                aria-valuemax={Math.max(1, goal.nodes.length)}
              >
                <span
                  style={{
                    width: `${goal.nodes.length ? (passedCount / goal.nodes.length) * 100 : 0}%`,
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
                      disabled={busy || sessionBusy}
                      onClick={() => void switchNode(value)}
                    >
                      <span className={`node-symbol ${value.status}`}>
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
                        {value.status !== "not_started" && (
                          <small>{nodeStatus[value.status]}</small>
                        )}
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
            <div className="lesson-content" ref={answerDropTarget}>
              <div className="lesson-scroll">
                <div className="lesson-inner">
                  <LearningSessionPanel
                    goal={goal}
                    continuation={continuations[goal.id]}
                    session={session}
                    busy={busy || sessionBusy || uploading}
                    savingDraft={savingDraft}
                    onStart={(minutes) => void beginSession(minutes)}
                    onPause={() => void changeSession("pause")}
                    onEnd={() => void changeSession("end")}
                    onEdit={() => openGoalEditor(goal)}
                  />
                  {draftConflict && <div className="learning-draft-conflict" role="alert"><p>会话草稿已在另一个操作中更新。当前输入仍保留，请选择继续使用哪一份。</p><Button size="sm" variant="outline" onClick={() => void resolveDraftConflict("remote")}>使用会话中的草稿</Button><Button size="sm" variant="ghost" onClick={() => void resolveDraftConflict("local")}>保留本机并覆盖会话草稿</Button></div>}
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
                            ? "XiaoXi 正在思考"
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
                                <Markdown>
                                  {learningStream.fields.exercise}
                                </Markdown>
                              </>
                            )}
                            {learningStream.fields.criteria && (
                              <>
                                <h3>检查标准</h3>
                                <Markdown>
                                  {learningStream.fields.criteria}
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
                          <Markdown>{lesson.content}</Markdown>
                          <section className="exercise-box">
                            <div className="section-title">
                              <FileQuestion size={20} />
                              <div>
                                <h2>现在轮到你试一试</h2>
                              </div>
                            </div>
                            <Markdown>{lesson.exercise}</Markdown>
                            <div className="exercise-criteria">
                              <strong>检查标准</strong>
                              <p>{lesson.criteria}</p>
                            </div>
                            {lesson.hints.length > 0 && (
                              <>
                                <button
                                  className="text-button"
                                  onClick={() => setHints(!hints)}
                                >
                                  {hints ? (
                                    <ChevronDown size={14} />
                                  ) : (
                                    <ChevronRight size={14} />
                                  )}
                                  需要一点提示
                                </button>
                                {hints && (
                                  <ul className="hint-list">
                                    {lesson.hints.map((hint, i) => (
                                      <li key={i}>{hint}</li>
                                    ))}
                                  </ul>
                                )}
                              </>
                            )}
                            <LearningConversation
                              turns={turns}
                              fallback={feedback}
                            />
                            {(turns.length > 0 || feedback?.explanation) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void reviewReminder()}
                              >
                                安排复习提醒
                              </Button>
                            )}
                            {busy && learningStream?.stage === "assessment" && (
                              <div
                                className="learning-live-reply"
                                aria-live="polite"
                              >
                                <span className="message-name">XiaoXi</span>
                                <Markdown>
                                  {learningStream.fields.explanation || ""}
                                </Markdown>
                                {learningStream.fields.next_step && (
                                  <Markdown>
                                    {learningStream.fields.next_step}
                                  </Markdown>
                                )}
                              </div>
                            )}
                          </section>
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
                  <section
                    className={`exercise-answer-dock ${answerExpanded ? "is-expanded" : "is-collapsed"}`}
                    aria-label="练习作答区"
                  >
                    <button
                      type="button"
                      className="exercise-answer-toggle"
                      aria-expanded={answerExpanded}
                      aria-controls="exercise-answer-body"
                      onClick={() => setAnswerExpanded((value) => !value)}
                    >
                      <span>
                        {lesson.state === "reviewed" ? "继续对话" : "作答"}
                        {(answer.trim() || images.length > 0) && (
                          <small>已保留草稿</small>
                        )}
                      </span>
                      {answerExpanded ? (
                        <ChevronDown size={15} />
                      ) : (
                        <ChevronUp size={15} />
                      )}
                    </button>
                    <div
                      id="exercise-answer-body"
                      className="exercise-answer-body"
                      hidden={!answerExpanded}
                    >
                      <div
                        ref={answerPreviewTarget}
                        className="exercise-answer-images"
                      />
                      <div className="exercise-answer-composer">
                        <Textarea
                          id="exercise-answer"
                          aria-label="练习回答"
                          rows={2}
                          value={answer}
                          onChange={(e) => setAnswer(e.target.value)}
                          onKeyDown={(event) => {
                            if (
                              event.key !== "Enter" ||
                              event.nativeEvent.isComposing ||
                              event.keyCode === 229
                            )
                              return;
                            event.preventDefault();
                            if (event.ctrlKey || event.metaKey) {
                              const input = event.currentTarget;
                              const start = input.selectionStart,
                                end = input.selectionEnd;
                              setAnswer(
                                answer.slice(0, start) +
                                  "\n" +
                                  answer.slice(end),
                              );
                              requestAnimationFrame(() => {
                                input.setSelectionRange(start + 1, start + 1);
                              });
                            } else if (
                              !busy &&
                              !uploading &&
                              (answer.trim() || images.length)
                            )
                              void submit();
                          }}
                          placeholder={
                            lesson.state === "reviewed"
                              ? "继续提问，或补充你的理解和练习结果…"
                              : "写下你的理解、操作结果或代码…"
                          }
                          disabled={busy}
                        />
                        <div className="exercise-submit">
                          <ImagesInput
                            key={lesson.id}
                            scopeKey={lesson.id}
                            dropTarget={answerDropTarget}
                            previewTarget={answerPreviewTarget}
                            previewMode="names"
                            images={images}
                            onChange={(values) => {
                              setImages(values);
                              if (values.length) setAnswerExpanded(true);
                            }}
                            disabled={busy}
                            onError={setError}
                            onUploading={setUploading}
                          />
                          <Hint label={busy ? "XiaoXi 正在思考" : "发送回答"}>
                            <Button
                              size="icon"
                              aria-label={busy ? "XiaoXi 正在思考" : "发送回答"}
                              disabled={
                                busy ||
                                uploading ||
                                (!answer.trim() && !images.length)
                              }
                              onClick={() => void submit()}
                            >
                              {busy ? (
                                <Loader2 size={16} className="spin" />
                              ) : (
                                <ArrowUp size={18} />
                              )}
                            </Button>
                          </Hint>
                        </div>
                      </div>
                    </div>
                  </section>
                )}
            </div>
          </div>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="learning-goal-editor">
          <DialogHeader>
            <DialogTitle>{editingGoalId ? "调整学习目标" : "你想学什么？"}</DialogTitle>
            <DialogDescription>
              {editingGoalId ? "修改目标信息，保留已有课程、练习与学习记录。" : "从一个具体目标开始，XiaoXi会为你建立知识框架。"}
            </DialogDescription>
          </DialogHeader>
          {error && <ErrorNotice message={error} />}
          <div className="form-field">
            <Label htmlFor="goal-title">学习主题</Label>
            <Input
              id="goal-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：家常菜、养猫、前端开发、某款游戏"
            />
          </div>
          <div className="form-field">
            <Label htmlFor="goal-objective">你希望学到什么程度</Label>
            <Textarea
              id="goal-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={3}
              placeholder="例如：能独立做出三道日常晚餐，知道如何安排步骤。"
            />
          </div>
          <div className="form-field">
            <Label htmlFor="goal-foundation">目前的基础与相关背景</Label>
            <Textarea
              id="goal-foundation"
              value={foundation}
              onChange={(e) => setFoundation(e.target.value)}
              rows={3}
              placeholder="已经会什么，在哪些地方容易卡住？"
            />
          </div>
          <div className="form-field">
            <Label htmlFor="goal-outcome">希望做出的具体成果（可选）</Label>
            <Textarea id="goal-outcome" rows={2} value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="例如：独立完成一份销售数据汇总表。" />
          </div>
          <div className="learning-goal-options">
            <div className="form-field"><Label htmlFor="goal-weekly-minutes">每周可用分钟（可选）</Label><Input id="goal-weekly-minutes" type="number" min={1} max={10080} value={weeklyMinutes} onChange={(event) => setWeeklyMinutes(event.target.value)} placeholder="例如：120" /></div>
            <div className="form-field"><Label htmlFor="goal-target-date">目标日期（可选）</Label><Input id="goal-target-date" type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} /></div>
          </div>
          <label className="learning-beginner-choice">
            <input
              type="checkbox"
              checked={useBeginnerDefaults}
              onChange={(event) => setUseBeginnerDefaults(event.target.checked)}
            />
            不确定怎么填写，按零基础入门安排未填写的部分
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              disabled={
                !title.trim() ||
                busy ||
                (Boolean(weeklyMinutes) && (!Number.isInteger(Number(weeklyMinutes)) || Number(weeklyMinutes) < 1 || Number(weeklyMinutes) > 10080)) ||
                (!useBeginnerDefaults &&
                  (!objective.trim() || !foundation.trim()))
              }
              onClick={() => void create()}
            >
              <Sparkles size={15} />
              {busy ? "正在保存…" : editingGoalId ? "保存目标" : "建立学习路线"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
