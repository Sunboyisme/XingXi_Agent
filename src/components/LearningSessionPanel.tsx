import { useEffect, useRef, useState } from "react";
import { History, Pause, Play, Settings2, Square } from "lucide-react";
import { api, type Goal } from "@/lib/api";
import { type LearningContinuation, type LearningSession, learningDate } from "@/lib/learningSessions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { LearningConversation } from "./LearningConversation";
import { Markdown } from "./common";
import "@/styles/learning-sessions.css";

export function LearningSessionPanel({ goal, continuation, session, busy, savingDraft, onStart, onPause, onEnd, onEdit }: {
  goal: Goal;
  continuation: LearningContinuation | undefined;
  session: LearningSession | null;
  busy: boolean;
  savingDraft: boolean;
  onStart: (minutes?: number) => void;
  onPause: () => void;
  onEnd: () => void;
  onEdit: () => void;
}) {
  const [minutes, setMinutes] = useState("15");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<LearningSession[]>([]);
  const [selected, setSelected] = useState<LearningSession | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const detailRequest = useRef(0);
  useEffect(() => {
    if (!historyOpen) return;
    let live = true;
    setLoading(true);
    setError("");
    setSelected(null);
    api<LearningSession[]>(`/learning/goals/${goal.id}/sessions`).then((values) => {
      if (live) setHistory(values);
    }).catch((cause: Error) => { if (live) setError(cause.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; detailRequest.current += 1; };
  }, [historyOpen, goal.id]);
  const hasSession = Boolean(session && session.status !== "ended");
  const status = session?.status === "active" ? "正在学习" : session?.status === "paused" ? "已暂停" : session?.status === "ended" ? "本次已结束" : "准备开始";
  const custom = Number(minutes);
  async function showSession(id: string) {
    const request = ++detailRequest.current;
    setLoading(true);
    setError("");
    setSelected(null);
    try {
      const saved = await api<LearningSession>(`/learning/sessions/${id}`);
      if (detailRequest.current === request) setSelected(saved);
    }
    catch (cause) { if (detailRequest.current === request) setError((cause as Error).message); }
    finally { if (detailRequest.current === request) setLoading(false); }
  }
  return <section className="learning-session-panel" aria-label="学习接续">
    <div className="learning-session-heading">
      <div><span className="learning-session-eyebrow">{status}{session?.target_minutes ? ` · 约 ${session.target_minutes} 分钟` : ""}</span><h2>{goal.title}</h2></div>
      <div className="learning-session-tools">
        <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}><Settings2 size={14} />目标设置</Button>
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}><History size={14} />学习记录</Button>
      </div>
    </div>
    <p className="learning-session-location">{continuation?.node_title ? `上次位置：${continuation.node_title}` : "从一个小目标开始"}<span>上次学习：{learningDate(continuation?.last_studied_at)}</span></p>
    {continuation?.gaps.length ? <p className="learning-session-gaps">当前卡点：{continuation.gaps.join("；")}</p> : null}
    <p className="learning-session-next">下一步：{continuation?.next_step || "选择一段时间，开始当前知识点。"}</p>
    <div className="learning-session-actions">
      <Button size="sm" disabled={busy} onClick={() => onStart()}><Play size={14} />{hasSession ? "继续上次" : "开始本次"}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => onStart(10)}>学 10 分钟</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => onStart(25)}>学 25 分钟</Button>
      <label className="learning-custom-duration"><span className="sr-only">自定义学习分钟数</span><Input aria-label="自定义学习分钟数" type="number" min={1} max={480} value={minutes} onChange={(event) => setMinutes(event.target.value)} /><Button size="sm" variant="ghost" disabled={busy || !Number.isInteger(custom) || custom < 1 || custom > 480} onClick={() => onStart(custom)}>分钟，开始</Button></label>
      {hasSession && <><Button size="sm" variant="ghost" disabled={busy || session?.status === "paused"} onClick={onPause}><Pause size={14} />暂停</Button><Button size="sm" variant="ghost" disabled={busy} onClick={onEnd}><Square size={13} />结束本次</Button></>}
    </div>
    <p className="learning-session-note">按你的时间安排内容，可随时暂停。{savingDraft ? "草稿正在保存…" : "结束本次不会将知识点标记为通过。"}{busy ? " 当前任务运行中，停止后可暂停或结束。" : ""}</p>
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
      <DialogContent className="learning-history-dialog"><DialogHeader><DialogTitle>{goal.title} · 学习记录</DialogTitle><DialogDescription>保存本次提交、反馈与下一步；记录结束不等于已经学会。</DialogDescription></DialogHeader>
        {error && <p role="alert">{error}</p>}
        {loading && <p role="status">正在读取学习记录…</p>}
        <div className="learning-history-content">
          <div className="learning-history-list">{history.map((item) => <button key={item.id} className={selected?.id === item.id ? "active" : ""} onClick={() => void showSession(item.id)}><strong>{learningDate(item.started_at)}</strong><span>{item.status === "ended" ? "已结束" : item.status === "paused" ? "已暂停" : "进行中"}{item.target_minutes ? ` · 约 ${item.target_minutes} 分钟` : ""}</span><small>{item.next_step || item.summary || "尚未提交练习"}</small></button>)}{!loading && !history.length && <p className="muted">还没有学习会话，原有课程和练习继续保留。</p>}</div>
          {selected && <article className="learning-history-detail"><h3>本次学习</h3><p>{selected.visited_node_ids.map((id) => goal.nodes.find((item) => item.id === id)?.title || "已移除的知识点").join(" → ") || "尚未选择知识点"}</p><p>{selected.summary}</p>{selected.gaps.length > 0 && <p>未解决：{selected.gaps.join("；")}</p>}<p>下一步：{selected.next_step || "尚未记录"}</p>{selected.draft.answer && <section><h4>未提交草稿</h4><Markdown>{selected.draft.answer}</Markdown></section>}<LearningConversation turns={selected.turns} />{!selected.turns.length && <p className="muted">本次还没有练习提交记录。</p>}</article>}
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}

