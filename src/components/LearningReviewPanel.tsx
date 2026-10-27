import { useEffect, useRef, useState } from "react";
import { ArrowLeft, RotateCcw, Square } from "lucide-react";
import { api, readEvents, type Run } from "@/lib/api";
import { type Review, useWorkflowDraft } from "@/lib/learningWorkflows";
import { Button } from "./ui/button";
import { Markdown, ErrorNotice } from "./common";
import { LearningComposer } from "./LearningComposer";
import { LearningConversation, LearningPendingReply } from "./LearningConversation";
import { errorMessage } from "@/lib/utils";

export function LearningReviewPanel({ goalId, onBack, refresh, onBusy }: {
  goalId: string; onBack: () => void; refresh: () => Promise<void>; onBusy: (value: boolean) => void;
}) {
  const [row, setRow] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopLock = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const draft = useWorkflowDraft("reviews", row, setError);
  useEffect(() => { onBusy(busy || uploading); return () => onBusy(false); }, [busy, uploading, onBusy]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [fields, row?.turns.length, busy]);
  async function track(value: Run, id: string) {
    controller.current?.abort(); const own = new AbortController(); controller.current = own;
    setBusy(true); setRun(value); setFields({});
    try {
      const done = ["queued", "running"].includes(value.status) ? await readEvents(value.id, (event) => {
        if (event.kind === "learning_content" && !own.signal.aborted) setFields(event.data.fields as Record<string, string>);
      }, own.signal) : value;
      if (own.signal.aborted) return;
      const saved = await api<Review>(`/learning/reviews/${id}`);
      if (done.status === "completed" && done.kind === "review_assessment") draft.clear();
      setRow(saved); setFields({}); setRun(done); await refresh();
      if (done.status === "failed") setError(done.error || "复习生成失败，可以重试。");
    } catch (cause) { if (!own.signal.aborted) setError(errorMessage(cause)); }
    finally { if (!own.signal.aborted) setBusy(false); }
  }
  async function open(live = () => true) {
    setBusy(true); setRun(null); setError("");
    try {
      const value = await api<Run>("/learning/reviews", "POST", { goal_id: goalId });
      const id = String(value.result.review_id || "");
      const saved = await api<Review>(`/learning/reviews/${id}`);
      if (!live()) return;
      setRow(saved); void track(value, id);
    } catch (cause) { if (live()) { setError(errorMessage(cause)); setBusy(false); } }
  }
  useEffect(() => { let live = true; void open(() => live); return () => { live = false; controller.current?.abort(); }; }, [goalId]);
  async function submit() {
    if (!row || busy || uploading) return;
    setBusy(true); setRun(null); setError("");
    try {
      await draft.flush();
      const value = await api<Run>(`/learning/reviews/${row.id}/submit`, "POST", { submission_id: crypto.randomUUID(), answer: draft.answer, attachment_ids: draft.images.map((item) => item.id) });
      void track(value, row.id);
    } catch (cause) { setBusy(false); setError(errorMessage(cause)); }
  }
  async function next() {
    if (!row || busy) return;
    try { await draft.flush(); await api(`/learning/reviews/${row.id}/end`, "POST"); draft.clear(); setRow(null); await open(); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  async function back() {
    try { await draft.flush(); onBack(); } catch (cause) { setError(errorMessage(cause)); }
  }
  async function stop() {
    if (!run || stopLock.current) return;
    stopLock.current = true; setStopping(true); setError("");
    try { const done = await api<Run>(`/runs/${run.id}/cancel`, "POST"); controller.current?.abort(); setRun(done); setBusy(false); setFields({}); if (row) setRow(await api(`/learning/reviews/${row.id}`)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { stopLock.current = false; setStopping(false); }
  }
  return <section className="learning-review-panel" aria-label="学习复习">
    <header className="learning-review-heading"><div><span>复习</span><h2>{row?.source.node_title || "回顾之前学过的内容"}</h2></div>
      <Button size="sm" variant="ghost" disabled={busy || uploading} onClick={() => void back()}><ArrowLeft size={14} />返回课程</Button></header>
    <div className="learning-workflow-scroll" ref={scroll}>
      {error && <ErrorNotice tone={error.includes("还没有可复习") ? "info" : "error"} message={error} />}
      {row && <><p className="muted">{row.source.basis}</p><span className="message-name">XiaoXi</span><Markdown numberedLists>{row.exercise || fields.exercise || ""}</Markdown>
        <LearningConversation turns={row.turns} />
        {busy && run?.kind === "review_assessment" && <LearningPendingReply answer={draft.answer} attachmentIds={draft.images.map((image) => image.id)} fields={fields} busy />}
      </>}
      {busy && <p className="learning-stream-status" role="status">正在分析中，请稍后…{!row?.exercise && <Button size="sm" variant="ghost" onClick={() => void stop()} disabled={!run || stopping}><Square size={12} />{stopping ? "正在停止…" : "停止"}</Button>}</p>}
      {!busy && error && (!row || !row.exercise) && <Button variant="outline" onClick={() => void open()}>重新读取复习</Button>}
      {Boolean(row?.turns.length) && !busy && <div className="learning-review-actions"><Button variant="outline" onClick={() => void next()}><RotateCcw size={15} />再来一题</Button><Button variant="ghost" onClick={() => void back()}>返回课程</Button></div>}
    </div>
    {row?.exercise && <LearningComposer answer={draft.answer} onAnswer={draft.setAnswer} images={draft.images} onImages={draft.setImages}
      onStop={busy && run && ["queued", "running"].includes(run.status) ? () => void stop() : undefined} stopping={stopping}
      scopeKey={row.id} busy={busy} uploading={uploading} onUploading={setUploading} onError={setError} onSubmit={() => void submit()} />}
  </section>;
}
