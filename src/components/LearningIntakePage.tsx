import { KnowledgeSources } from "./KnowledgeSources";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, Sparkles, Square } from "lucide-react";
import { api, readEvents, type Run } from "@/lib/api";
import { type Intake, useWorkflowDraft } from "@/lib/learningWorkflows";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { DateTimePicker } from "./DateTimePicker";
import { ErrorNotice, Markdown } from "./common";
import { LearningComposer } from "./LearningComposer";
import { registerLearningFlush } from "@/lib/learningLifecycle";

export function LearningIntakePage({ intakeId, onBack, onCreated }: { intakeId?: string; onBack: () => void; onCreated: (goalId: string) => Promise<void> }) {
  const creationId = useRef(crypto.randomUUID());
  const sending = useRef(false);
  const [initialAnswer, setInitialAnswer] = useState("");
  const [loading, setLoading] = useState(Boolean(intakeId));
  const [row, setRow] = useState<Intake | null>(null);
  const [summary, setSummary] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState("");
  const [minutes, setMinutes] = useState("");
  const [date, setDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopLock = useRef(false);
  const [run, setRun] = useState<Run | null>(null);
  const controller = useRef<AbortController | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const draft = useWorkflowDraft("intakes", row, setError);
  const form = useRef({ row, summary, outcome, minutes, date, dirty: false });
  form.current = { ...form.current, row, summary, outcome, minutes, date };
  const formWrites = useRef(Promise.resolve());
  function formValue(value: typeof form.current) {
    return { title: value.summary.title || "", objective: value.summary.objective || "", foundation: value.summary.foundation || "",
      outcome: value.outcome, weekly_minutes: value.minutes, target_date: value.date };
  }
  function flushForm() {
    const work = formWrites.current.catch(() => {}).then(async () => {
      const value = form.current;
      if (!value.dirty || !value.row || value.row.goal_id) return;
      const submitted = formValue(value);
      await api(`/learning/intakes/${value.row.id}/summary`, "PUT", { summary: submitted });
      if (JSON.stringify(formValue(form.current)) === JSON.stringify(submitted)) form.current.dirty = false;
    });
    formWrites.current = work;
    return work;
  }
  useEffect(() => registerLearningFlush(flushForm), []);
  useEffect(() => {
    if (!form.current.dirty) return;
    const timer = setTimeout(() => void flushForm().catch((cause: Error) => setError(`目标摘要保存失败：${cause.message}`)), 700);
    return () => clearTimeout(timer);
  }, [summary, outcome, minutes, date]);
  const minutesInvalid = Boolean(minutes) && (!/^\d+$/.test(minutes) || Number(minutes) < 1 || Number(minutes) > 10080);
  async function reload(id: string) {
    const value = await api<Intake>(`/learning/intakes/${id}`);
    setRow(value); setSummary(value.summary); setOutcome(String(value.summary.outcome || "")); setMinutes(String(value.summary.weekly_minutes || "")); setDate(value.summary.target_date || ""); form.current.dirty = false; return value;
  }
  async function track(value: Run, id: string) {
    controller.current?.abort(); const own = new AbortController(); controller.current = own;
    setBusy(true); setRun(value);
    try {
      const done = ["queued", "running"].includes(value.status)
        ? await readEvents(value.id, () => {}, own.signal) : value;
      if (own.signal.aborted) return;
      const saved = await reload(id); setRun(done);
      if (done.status === "completed" && done.kind === "course" && saved.goal_id) await onCreated(saved.goal_id);
      else if (done.status === "failed") setError(done.error || "本次生成失败，已保留对话，可重试。");
    } catch (cause) { if (!own.signal.aborted) setError((cause as Error).message); }
    finally { if (!own.signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    let live = true;
    if (intakeId) api<Intake>(`/learning/intakes/${intakeId}`).then(async (value) => {
      if (!live) return; setRow(value); setSummary(value.summary); setOutcome(String(value.summary.outcome || "")); setMinutes(String(value.summary.weekly_minutes || "")); setDate(value.summary.target_date || "");
      if (value.active_run_id) {
        const previous = await api<Run>(`/runs/${value.active_run_id}`);
        if (live) void track(previous, value.id);
      }
    }).catch((cause: Error) => { if (live) setError(cause.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.current?.abort(); };
  }, []);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }, [row?.messages.length, busy]);
  async function send(content = row ? draft.answer : initialAnswer, beginner = false, messageId: string = crypto.randomUUID()) {
    if (sending.current || busy || loading || !content.trim()) return;
    sending.current = true;
    setBusy(true); setRun(null); setError("");
    try {
      if (!row) {
        const saved = await api<Intake>("/learning/intakes", "POST", { content, message_id: messageId, creation_id: creationId.current });
        setInitialAnswer(""); await reload(saved.id);
        if (saved.active_run_id) void track(await api<Run>(`/runs/${saved.active_run_id}`), saved.id);
        else setBusy(false);
        return;
      }
      await draft.flush(); await flushForm();
      const value = await api<Run>(`/learning/intakes/${row.id}/messages`, "POST", { content, message_id: messageId, use_beginner_defaults: beginner });
      draft.clear(); await reload(row.id); void track(value, row.id);
    } catch (cause) { setError((cause as Error).message); setBusy(false); }
    finally { sending.current = false; }
  }
  async function confirm() {
    if (!row || busy || sending.current || minutesInvalid) return;
    sending.current = true;
    setBusy(true); setRun(null); setError("");
    try {
      await draft.flush(); await flushForm();
      const value = await api<Run>(`/learning/intakes/${row.id}/confirm`, "POST", { ...summary, outcome,
        weekly_minutes: minutes ? Number(minutes) : null, target_date: date || null });
      await reload(row.id); void track(value, row.id);
    } catch (cause) { setError((cause as Error).message); setBusy(false); }
    finally { sending.current = false; }
  }
  async function stop() {
    if (!run || stopLock.current) return;
    stopLock.current = true; setStopping(true); setError("");
    try { const done = await api<Run>(`/runs/${run.id}/cancel`, "POST"); controller.current?.abort(); setRun(done); setBusy(false); if (row) await reload(row.id); }
    catch (cause) { setError((cause as Error).message); }
    finally { stopLock.current = false; setStopping(false); }
  }
  const ready = Boolean(row && ["ready", "confirmed"].includes(row.status));
  const lastUser = row?.messages.filter((item) => item.role === "user").at(-1);
  return <div className="learning-intake-page">
    <header className="learning-workflow-heading">
      <Button variant="ghost" disabled={busy} onClick={() => void Promise.all([draft.flush(), flushForm()]).then(onBack).catch((cause: Error) => setError(cause.message))}><ArrowLeft size={16} />返回学习</Button>
      <h1>一起确定你的学习方向</h1><p>XiaoXi 会帮你规划好适合你的学习路线。</p>
    </header>
    <div className="learning-workflow-scroll" ref={scroll}>
      {error && !ready && <ErrorNotice message={error} />}
      {loading && <p role="status">正在读取学习对话…</p>}
      {!row && !loading && <article className="learning-intake-reply"><span className="message-name">XiaoXi</span><p>你想学会什么，或解决什么问题？</p></article>}
      {row?.messages.map((message, index) => <article key={index} className={message.role === "user" ? "learning-user-reply" : "learning-intake-reply"}>
        <span className="message-name">{message.role === "user" ? "你" : "XiaoXi"}</span><Markdown>{message.content}</Markdown><KnowledgeSources sources={message.knowledge_sources} />
      </article>)}
      {busy && <p className="learning-stream-status" role="status"><Loader2 size={15} className="spin" />{run?.kind === "course" ? "正在生成学习路线…" : "正在分析中，请稍后…"}{row?.goal_id && <Button variant="ghost" size="sm" onClick={() => void stop()} disabled={!run || stopping}><Square size={13} />{stopping ? "正在停止…" : "停止"}</Button>}</p>}
      {!busy && run?.status === "failed" && lastUser && !row?.goal_id && <Button variant="outline" onClick={() => void send(lastUser.content, false, lastUser.message_id)}>重试上次回答</Button>}
      {ready && <section className="learning-intake-summary" aria-label="学习目标摘要">
        <h2>你的学习目标</h2>
        {[["title", "学习主题"], ["objective", "希望具备的能力"], ["foundation", "目前基础"]].map(([key, label]) => <label key={key}>{label}
          {key === "title" ? <Input value={summary[key] || ""} maxLength={200} disabled={busy || Boolean(row?.goal_id)} onChange={(event) => { form.current.dirty = true; setSummary({ ...summary, [key]: event.target.value }); }} />
            : <Textarea rows={2} value={summary[key] || ""} maxLength={4000} disabled={busy || Boolean(row?.goal_id)} onChange={(event) => { form.current.dirty = true; setSummary({ ...summary, [key]: event.target.value }); }} />}
        </label>)}
        <div className="learning-intake-options">
          <label>想完成的小成果（可选）<Input value={outcome} maxLength={4000} onChange={(event) => { form.current.dirty = true; setOutcome(event.target.value); }} disabled={busy || Boolean(row?.goal_id)} /></label>
          <label>每周投入分钟（可选）<Input inputMode="numeric" value={minutes} aria-invalid={minutesInvalid} maxLength={5} onChange={(event) => { form.current.dirty = true; setMinutes(event.target.value); }} disabled={busy || Boolean(row?.goal_id)} />{minutesInvalid && <small role="alert">填写 1 至 10080 的整数，或留空。</small>}</label>
          <label>目标日期（可选）<DateTimePicker id="intake-target-date" disabled={busy || Boolean(row?.goal_id)} dateOnly label="目标日期" value={date} onChange={(value) => { form.current.dirty = true; setDate(value); }} /></label>
        </div>
        <div className="learning-generation-action" aria-busy={busy}>
          <Button onClick={() => void confirm()} disabled={busy || minutesInvalid || ["title", "objective", "foundation"].some((key) => !summary[key]?.trim())}>
            {busy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}{busy ? (run?.kind === "course" ? "正在生成学习路线…" : "正在提交…") : row?.goal_id ? "重试生成路线" : "确认并生成学习路线"}
          </Button>
          {busy && <span role="status">学习目标已保留，生成完成后会自动打开课程。</span>}
          {error && <ErrorNotice message={error} />}
        </div>
      </section>}
      {row && !ready && !busy && row.messages.length > 1 && <Button variant="outline" size="sm" onClick={() => void send("我明确选择按零基础入门安排，未说明的目标采用入门小实践。", true)}>先按零基础入门安排</Button>}
    </div>
    {!row?.goal_id && <LearningComposer answer={row ? draft.answer : initialAnswer} onAnswer={row ? draft.setAnswer : setInitialAnswer} busy={busy || loading} onError={setError}
      onStop={busy && run && ["queued", "running"].includes(run.status) ? () => void stop() : undefined} stopping={stopping}
      onSubmit={() => void send()} scopeKey={row?.id || "intake"} label="学习目标对话" placeholder="告诉 XiaoXi 你的想法…" />}
  </div>;
}
