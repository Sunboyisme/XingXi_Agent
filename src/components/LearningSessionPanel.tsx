import { useEffect, useRef, useState } from "react";
import { Tabs } from "radix-ui";
import { BellPlus, History, Pause, Settings2, Square, RotateCcw, Check } from "lucide-react";
import type { Review } from "@/lib/learningWorkflows";
import { api, type Goal } from "@/lib/api";
import { type LearningSession, learningDate } from "@/lib/learningSessions";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { LearningConversation } from "./LearningConversation";
import { Markdown } from "./common";
import "@/styles/learning-sessions.css";
import { errorMessage } from "@/lib/utils";

const statusLabels: Record<string, string> = {
  ended: "已结束",
  paused: "已暂停",
  active: "进行中",
};

export function LearningSessionPanel({
  goal,
  session,
  busy,
  onPause,
  onEnd,
  onEdit,
  onReviewReminder,
  onReview,
  ending = false,
  onComplete,
}: {
  goal: Goal;
  session: LearningSession | null;
  busy: boolean;
  onPause: () => void;
  onEnd: () => void;
  onEdit: () => void;
  onReviewReminder?: () => void;
  onReview: () => void;
  ending?: boolean;
  onComplete?: () => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<LearningSession[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<LearningSession | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const detailRequest = useRef(0);
  const detailPane = useRef<HTMLElement>(null);
  const hasSession = Boolean(session && session.status !== "ended");
  const nodeTitles = (item: LearningSession) =>
    item.visited_node_ids.map(
      (id) =>
        goal.nodes.find((node) => node.id === id)?.title || "已移除的知识点",
    );

  useEffect(() => {
    if (!historyOpen) return;
    let live = true;
    setLoadingList(true);
    setHistory([]);
    setError("");
    setSelected(null);
    setSelectedId("");
    api<LearningSession[]>(`/learning/goals/${goal.id}/sessions`)
      .then((values) => {
        if (live) {
          const ordered = [...values].sort(
            (a, b) =>
              b.started_at.localeCompare(a.started_at) ||
              b.id.localeCompare(a.id),
          );
          setHistory(ordered);
          setSelectedId(ordered[0]?.id || "");
        }
      })
      .catch((cause) => {
        if (live) setError(errorMessage(cause));
      })
      .finally(() => {
        if (live) setLoadingList(false);
      });
    return () => {
      live = false;
      detailRequest.current += 1;
    };
  }, [historyOpen, goal.id, listRevision]);

  useEffect(() => {
    if (!historyOpen || !selectedId) return;
    const request = ++detailRequest.current;
    setLoadingDetail(true);
    setError("");
    setSelected(null);
    Promise.all([api<LearningSession>(`/learning/sessions/${selectedId}`),
      api<Review[]>(`/learning/reviews?goal_id=${goal.id}&session_id=${selectedId}`)])
      .then(([value, savedReviews]) => {
        if (detailRequest.current === request) {
          setSelected(value);
          setReviews(savedReviews);
          detailPane.current?.scrollTo({ top: 0 });
        }
      })
      .catch((cause) => {
        if (detailRequest.current === request) setError(errorMessage(cause));
      })
      .finally(() => {
        if (detailRequest.current === request) setLoadingDetail(false);
      });
    return () => {
      detailRequest.current += 1;
    };
  }, [historyOpen, selectedId, detailRevision]);

  return (
    <div className="learning-session-toolbar" aria-label="学习工具">
      <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
        <Settings2 size={14} />
        目标设置
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
        <History size={14} />
        学习记录
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onReview}
        disabled={busy}
      ><RotateCcw size={14} />复习</Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onReviewReminder}
        disabled={busy || !onReviewReminder}
      >
        <BellPlus size={14} />
        复习提醒
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || session?.status !== "active"}
        onClick={onPause}
      >
        <Pause size={14} />
        暂停
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={ending || !hasSession}
        onClick={onEnd}
      >
        <Square size={13} />
        {ending ? "正在结束…" : "结束学习"}
      </Button>
      {onComplete && <Button size="sm" variant="outline" disabled={busy || ending} onClick={onComplete}><Check size={14} />完成本章</Button>}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="learning-history-dialog">
          <DialogHeader>
            <DialogTitle>{goal.title} · 学习记录</DialogTitle>
            <DialogDescription>
              按时间回看每次学习的知识点、对话与草稿。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <div className="learning-history-error" role="alert">
              <p>{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  selectedId
                    ? setDetailRevision((value) => value + 1)
                    : setListRevision((value) => value + 1)
                }
              >
                重新读取
              </Button>
            </div>
          )}
          <div className="learning-history-workspace">
            <nav className="learning-history-sidebar" aria-label="选择学习记录">
              <div className="learning-history-list-heading">
                <strong>全部记录</strong>
                <span>{history.length} 次</span>
              </div>
              <div className="learning-history-entries">
                {loadingList && <p role="status">正在读取记录…</p>}
                {history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={selectedId === item.id ? "true" : undefined}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <div>
                      <time dateTime={item.started_at}>
                        {learningDate(item.started_at)}
                      </time>
                      <span
                        className="learning-history-status"
                        data-status={item.status}
                      >
                        {statusLabels[item.status]}
                      </span>
                    </div>
                    <strong>{nodeTitles(item).join("、") || "课程准备"}</strong>
                    <small>
                      {item.visited_node_ids.length} 个知识点
                      {item.target_minutes
                        ? ` · 计划约 ${item.target_minutes} 分钟`
                        : ""}
                    </small>
                  </button>
                ))}
                {!loadingList && !history.length && (
                  <p className="muted">
                    还没有学习记录。开始一个知识点后，这里会保存本次学习。
                  </p>
                )}
              </div>
            </nav>
            <article
              className="learning-history-reading"
              ref={detailPane}
              aria-busy={loadingDetail}
            >
              {loadingDetail && <p role="status">正在读取本次学习…</p>}
              {!loadingDetail && selected && (
                <>
                  <header className="learning-history-detail-heading">
                    <span>
                      {statusLabels[selected.status]} · {selected.turns.length}{" "}
                      轮对话
                    </span>
                    <h2>{learningDate(selected.started_at)}</h2>
                    <p>
                      {nodeTitles(selected).join(" / ") || "尚未选择知识点"}
                    </p>
                  </header>
                  <Tabs.Root defaultValue="conversation" key={selected.id}>
                    <Tabs.List
                      className="content-view-tabs"
                      aria-label="学习记录内容"
                    >
                      <Tabs.Trigger value="conversation">对话记录</Tabs.Trigger>
                      <Tabs.Trigger value="overview">本次概况</Tabs.Trigger>
                    </Tabs.List>
                    <Tabs.Content value="conversation">
                      <LearningConversation turns={selected.turns} />
                      {reviews.map((review) => <section className="learning-history-review" key={review.id}>
                        <h3>复习 · {review.source.node_title}</h3><Markdown numberedLists>{review.exercise}</Markdown>
                        <LearningConversation turns={review.turns} />
                        {review.draft.answer && <><h4>未提交草稿</h4><Markdown>{review.draft.answer}</Markdown></>}
                      </section>)}
                      {!selected.turns.length && !reviews.length && (
                        <p className="history-empty">
                          本次还没有提交练习或开始对话。
                        </p>
                      )}
                    </Tabs.Content>
                    <Tabs.Content
                      value="overview"
                      className="learning-history-overview"
                    >
                      <section>
                        <h3>学习摘要</h3>
                        <Markdown>
                          {selected.summary || "尚未记录反馈"}
                        </Markdown>
                      </section>
                      <section>
                        <h3>下一步</h3>
                        <Markdown>
                          {selected.next_step || "回到课程，继续当前知识点。"}
                        </Markdown>
                      </section>
                      {selected.gaps.length > 0 && (
                        <section>
                          <h3>仍需练习</h3>
                          <ul>
                            {selected.gaps.map((gap, index) => (
                              <li key={index}>{gap}</li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {selected.draft.answer && (
                        <section>
                          <h3>未提交草稿</h3>
                          <Markdown>{selected.draft.answer}</Markdown>
                        </section>
                      )}
                    </Tabs.Content>
                  </Tabs.Root>
                </>
              )}
              {!loadingList && !loadingDetail && !selected && !error && (
                <div className="history-empty">
                  <History size={28} />
                  <p>学习过程会保存在这里，方便下次接着学。</p>
                </div>
              )}
            </article>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
