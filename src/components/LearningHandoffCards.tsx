import { useEffect, useState } from "react";
import { BookOpen, ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import "@/styles/learning-handoff.css";

type Continuation = { goal_id: string; goal_title: string; session_id?: string | null; node_title?: string; summary: string; gaps: string[]; next_step: string };
export function LearningHandoffCards({ runId, status }: { runId: string; status?: string | null }) {
  const [cards, setCards] = useState<Continuation[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api<Continuation[]>(`/runs/${runId}/learning-continuations`).then((values) => { if (live) setCards(values); }).catch(() => {});
    return () => { live = false; };
  }, [runId, status]);
  async function open(card: Continuation) {
    setError("");
    try {
      await api(`/learning/goals/${card.goal_id}/continuation`);
      if (card.session_id) await api(`/learning/sessions/${card.session_id}`);
      window.dispatchEvent(new CustomEvent("xiaoxi-open-learning", { detail: { goalId: card.goal_id, sessionId: card.session_id || undefined, key: Date.now() } }));
    } catch { setError("这条学习记录已失效或暂时无法读取。"); }
  }
  if (!cards.length) return null;
  return <div className="learning-handoff-cards">{cards.map((card) => <button className="learning-handoff-card" key={card.goal_id} onClick={() => void open(card)}>
    <BookOpen size={20} /><span><strong>{card.goal_title}</strong><small>{card.node_title || card.summary || "继续已有学习目标"}</small><span>{card.gaps?.[0] ? `当前卡点：${card.gaps[0]}` : card.next_step}</span></span><ArrowRight size={17} />
  </button>)}{error && <p role="alert">{error} <button onClick={() => window.dispatchEvent(new CustomEvent("xiaoxi-open-learning", { detail: { goalId: "", key: Date.now() } }))}>打开学习列表</button></p>}</div>;
}
