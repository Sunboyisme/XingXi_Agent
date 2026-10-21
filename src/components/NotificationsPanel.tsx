import { useEffect, useRef, useState } from "react";
import { Bell, Check, Clock3, ExternalLink } from "lucide-react";
import { api, type Notification } from "@/lib/api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { ErrorNotice } from "./common";
import { dateTime } from "@/lib/utils";

export function NotificationsPanel({
  open,
  onOpenChange,
  notifications,
  refresh,
  onPlan,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  notifications: Notification[];
  refresh: () => Promise<void>;
  onPlan: (id: string, occurrence?: string | null) => void;
}) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const historyRequest = useRef(0);
  async function loadHistory(offset: number) {
    const request = ++historyRequest.current;
    setLoading(true);
    setError("");
    try {
      const page = await api<Notification[]>(
        `/notifications?offset=${offset}&limit=50`,
      );
      if (request !== historyRequest.current) return;
      setHistory((items) =>
        offset === 0
          ? page
          : [
              ...items,
              ...page.filter(
                (note) => !items.some((item) => item.id === note.id),
              ),
            ],
      );
      setMore(page.length === 50);
      setNextOffset(offset + page.length);
    } catch (error) {
      if (request === historyRequest.current)
        setError((error as Error).message);
    } finally {
      if (request === historyRequest.current) setLoading(false);
    }
  }
  useEffect(() => {
    setHistory([]);
    setMore(false);
    setNextOffset(0);
    setLoading(false);
    if (open && all) void loadHistory(0);
    return () => {
      historyRequest.current++;
    };
  }, [open, all]);
  const values = all ? history : notifications;
  async function act(note: Notification, snooze = false) {
    setBusy(note.id);
    setError("");
    try {
      const updated = await api<Notification>(
        `/notifications/${note.id}/${snooze ? "snooze" : "ack?read=true"}`,
        "POST",
        snooze ? { minutes: 10 } : undefined,
      );
      setHistory((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="notifications-dialog">
        <DialogHeader>
          <DialogTitle>
            <Bell size={20} />
            通知
          </DialogTitle>
          <DialogDescription>
            查看已触发的提醒。「知道了」只标记已读，不会完成计划。
          </DialogDescription>
        </DialogHeader>
        <div className="segmented">
          <button
            aria-pressed={!all}
            className={!all ? "selected" : ""}
            onClick={() => setAll(false)}
          >
            未读
          </button>
          <button
            aria-pressed={all}
            className={all ? "selected" : ""}
            onClick={() => setAll(true)}
          >
            全部
          </button>
        </div>
        {error && (
          <ErrorNotice
            message={error}
            retry={all ? () => void loadHistory(nextOffset) : undefined}
          />
        )}
        {!values.length && !loading && (
          <p className="notification-empty">
            {all ? "还没有通知" : "没有未读通知"}
          </p>
        )}
        <div className="plan-notification-list">
          {values.map((note) => (
            <article className="plan-notification" key={note.id}>
              <div>
                <strong>{note.title}</strong>
                <small>
                  {dateTime(note.occurrence_at)} ·{" "}
                  {note.status === "read"
                    ? "已读"
                    : note.status === "snoozed"
                      ? `稍后提醒 · ${dateTime(note.snoozed_until || note.occurrence_at)}`
                      : "未读"}
                </small>
                {note.body && <p>{note.body}</p>}
              </div>
              <div className="notification-actions">
                {note.plan_id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onOpenChange(false);
                      onPlan(note.plan_id!, note.plan_occurrence_start);
                    }}
                  >
                    <ExternalLink size={14} />
                    查看计划
                  </Button>
                )}
                {["pending", "presented"].includes(note.status) && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(busy) || loading}
                      onClick={() => void act(note, true)}
                    >
                      <Clock3 size={14} />
                      10 分钟后提醒
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(busy) || loading}
                      onClick={() => void act(note)}
                    >
                      <Check size={14} />
                      知道了
                    </Button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
        {all && (more || loading) && (
          <Button
            variant="ghost"
            disabled={loading}
            onClick={() => void loadHistory(nextOffset)}
          >
            {loading ? "正在读取…" : "加载更多通知"}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
