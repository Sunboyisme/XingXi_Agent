import { useEffect, useRef, useState } from "react";
import { ArrowLeft, RotateCcw, Square } from "lucide-react";
import { api, readEvents, type Run } from "@/lib/api";
import { type Review, useWorkflowDraft } from "@/lib/learningWorkflows";
import { Button } from "./ui/button";
import { Markdown, ErrorNotice } from "./common";
import { LearningComposer } from "./LearningComposer";
import {
  LearningConversation,
  LearningPendingReply,
} from "./LearningConversation";
import { errorMessage } from "@/lib/utils";
import { isActiveRun } from "@/lib/avatarActivity";

export function LearningReviewPanel({
  goalId,
  onBack,
  refresh,
  onBusy,
}: {
  goalId: string;
  onBack: () => void;
  refresh: () => Promise<void>;
  onBusy: (value: boolean) => void;
}) {
  const [row, setRow] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopLock = useRef(false);
  const actionLock = useRef(false);
  const scope = useRef(0);
  const following = useRef(true);
  const [action, setAction] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const draft = useWorkflowDraft("reviews", row, setError);
  useEffect(() => {
    onBusy(busy || uploading || stopping);
    return () => onBusy(false);
  }, [busy, uploading, stopping, onBusy]);
  useEffect(() => {
    if (following.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [fields, row?.turns.length, busy]);
  async function perform(kind: string, work: (epoch: number) => Promise<void>) {
    if (actionLock.current || stopLock.current || uploading) return;
    const epoch = scope.current;
    actionLock.current = true;
    setBusy(true);
    setAction(kind);
    setError("");
    setSyncWarning("");
    try {
      await work(epoch);
    } catch (cause) {
      if (
        epoch === scope.current &&
        !(cause instanceof Error && cause.name === "AbortError")
      )
        setError(errorMessage(cause));
    } finally {
      if (epoch === scope.current) {
        actionLock.current = false;
        setAction("");
        if (!stopLock.current) setBusy(false);
      }
    }
  }
  async function track(
    value: Run,
    id: string,
    epoch: number,
    submitted = false,
  ) {
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    const live = () => epoch === scope.current && !own.signal.aborted;
    setRun(value);
    setFields({});
    const done = isActiveRun(value.status)
      ? await readEvents(
          value.id,
          (event) => {
            if (event.kind === "learning_content" && live())
              setFields(event.data.fields as Record<string, string>);
          },
          own.signal,
        )
      : value;
    if (!live()) return;
    const saved = await api<Review>(`/learning/reviews/${id}`);
    if (!live()) return;
    if (
      submitted &&
      done.status === "completed" &&
      done.kind === "review_assessment"
    )
      draft.clear();
    setRow(saved);
    setFields({});
    setRun(done);
    if (done.status === "failed")
      setError(done.error || "复习生成失败，可以重试。");
    try {
      await refresh();
    } catch {
      if (live()) setSyncWarning("复习记录已保存，课程列表暂未刷新。");
    }
  }
  async function loadReview(epoch: number) {
    setRun(null);
    setFields({});
    following.current = true;
    const value = await api<Run>("/learning/reviews", "POST", {
      goal_id: goalId,
    });
    if (epoch !== scope.current) return;
    const id = String(value.result.review_id || "");
    if (!id) throw new Error("未能读取复习记录，请重新读取。");
    const saved = await api<Review>(`/learning/reviews/${id}`);
    if (epoch !== scope.current) return;
    setRow(saved);
    await track(value, id, epoch);
  }
  async function open() {
    await perform("opening", loadReview);
  }
  useEffect(() => {
    scope.current++;
    actionLock.current = false;
    stopLock.current = false;
    setRow(null);
    setStopping(false);
    void open();
    return () => {
      scope.current++;
      controller.current?.abort();
    };
  }, [goalId]);
  async function submit() {
    if (!row || busy || (!draft.answer.trim() && !draft.images.length)) return;
    await perform("submitting", async (epoch) => {
      following.current = true;
      setRun(null);
      await draft.flush();
      if (epoch !== scope.current) return;
      const value = await api<Run>(
        `/learning/reviews/${row.id}/submit`,
        "POST",
        {
          submission_id: crypto.randomUUID(),
          answer: draft.answer,
          attachment_ids: draft.images.map((item) => item.id),
        },
      );
      if (epoch === scope.current) await track(value, row.id, epoch, true);
    });
  }
  async function next() {
    if (!row || busy) return;
    await perform("next", async (epoch) => {
      setRun(null);
      await draft.flush();
      if (epoch !== scope.current) return;
      await api(`/learning/reviews/${row.id}/end`, "POST");
      if (epoch !== scope.current) return;
      draft.clear();
      setRow(null);
      await loadReview(epoch);
    });
  }
  async function back() {
    if (busy) return;
    await perform("back", async (epoch) => {
      await draft.flush();
      if (epoch === scope.current) onBack();
    });
  }
  async function stop() {
    if (!run || !isActiveRun(run.status) || stopLock.current) return;
    const epoch = scope.current;
    stopLock.current = true;
    setStopping(true);
    setError("");
    let cancelled = false;
    try {
      const done = await api<Run>(`/runs/${run.id}/cancel`, "POST");
      if (epoch !== scope.current) return;
      cancelled = true;
      controller.current?.abort();
      setRun(done);
      setFields({});
      if (row) {
        const saved = await api<Review>(`/learning/reviews/${row.id}`);
        if (epoch === scope.current) setRow(saved);
      }
    } catch (cause) {
      if (epoch === scope.current) setError(errorMessage(cause));
    } finally {
      if (epoch === scope.current) {
        stopLock.current = false;
        setStopping(false);
        if (cancelled || !actionLock.current) setBusy(false);
      }
    }
  }
  return (
    <section className="learning-review-panel" aria-label="学习复习">
      <header className="learning-review-heading">
        <div>
          <span>复习</span>
          <h2>{row?.source.node_title || "回顾之前学过的内容"}</h2>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || uploading || stopping}
          onClick={() => void back()}
        >
          <ArrowLeft size={14} />
          返回课程
        </Button>
      </header>
      <div
        className="learning-workflow-scroll"
        ref={scroll}
        onWheel={(event) => {
          if (event.deltaY < 0) following.current = false;
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            24;
        }}
      >
        {error && (
          <ErrorNotice
            tone={error.includes("还没有可复习") ? "info" : "error"}
            message={error}
          />
        )}
        {syncWarning && (
          <ErrorNotice
            tone="warning"
            message={syncWarning}
            onClose={() => setSyncWarning("")}
          />
        )}
        {row && (
          <>
            <p className="muted">{row.source.basis}</p>
            <span className="message-name">XiaoXi</span>
            <Markdown numberedLists>
              {row.exercise || fields.exercise || ""}
            </Markdown>
            <LearningConversation turns={row.turns} />
            {busy && run?.kind === "review_assessment" && (
              <LearningPendingReply
                answer={draft.answer}
                attachmentIds={draft.images.map((image) => image.id)}
                fields={fields}
                busy
              />
            )}
          </>
        )}
        {busy && (
          <p className="learning-stream-status" role="status">
            {action === "back"
              ? "正在保存草稿…"
              : action === "next" && !run
                ? "正在准备下一题…"
                : "正在分析中，请稍后…"}
            {!row?.exercise && run && isActiveRun(run.status) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void stop()}
                disabled={stopping}
              >
                <Square size={12} />
                {stopping ? "正在停止…" : "停止"}
              </Button>
            )}
          </p>
        )}
        {!busy && error && (!row || !row.exercise) && (
          <Button
            variant="outline"
            disabled={uploading || stopping}
            onClick={() => void open()}
          >
            重新读取复习
          </Button>
        )}
        {Boolean(row?.turns.length) && !busy && (
          <div className="learning-review-actions">
            <Button
              variant="outline"
              disabled={uploading || stopping}
              onClick={() => void next()}
            >
              <RotateCcw size={15} />
              再来一题
            </Button>
            <Button
              variant="ghost"
              disabled={uploading || stopping}
              onClick={() => void back()}
            >
              返回课程
            </Button>
          </div>
        )}
      </div>
      {row?.exercise && (
        <LearningComposer
          answer={draft.answer}
          onAnswer={draft.setAnswer}
          images={draft.images}
          onImages={draft.setImages}
          onStop={
            busy && run && isActiveRun(run.status)
              ? () => void stop()
              : undefined
          }
          stopping={stopping}
          scopeKey={row.id}
          busy={busy}
          uploading={uploading}
          onUploading={setUploading}
          onError={setError}
          onSubmit={() => void submit()}
        />
      )}
    </section>
  );
}
