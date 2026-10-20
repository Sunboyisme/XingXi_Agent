import { useEffect, useState } from "react";
import { Bookmark, Check, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type Memory } from "@/lib/api";
import { dateTime } from "@/lib/utils";
import { ErrorNotice } from "./common";

export type MemoryNotice = {
  change_id: string;
  content: string;
  action: string;
};

export function MemorySource({ memory }: { memory: Memory }) {
  return (
    <details className="memory-provenance">
      <summary>查看来源</summary>
      <div>
        <span>{memory.source}</span>
        <time>{dateTime(memory.updated_at)}</time>
      </div>
      {memory.evidence && <blockquote>{memory.evidence}</blockquote>}
    </details>
  );
}

export function MemoryReview({
  memory,
  refresh,
}: {
  memory: Memory;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(confirm: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(
        confirm ? `/memories/${memory.id}/confirm` : `/memories/${memory.id}`,
        confirm ? "POST" : "DELETE",
        confirm ? { revision: memory.revision } : undefined,
      );
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="memory-review" aria-label="待确认记忆">
      <div className="memory-review-heading">
        <Bookmark size={17} aria-hidden="true" />
        <span>
          {memory.replaces_id ? "要更新这条记忆吗？" : "要记住这条信息吗？"}
        </span>
        {memory.review_reason && <small>{memory.review_reason}</small>}
      </div>
      <p>{memory.content}</p>
      <MemorySource memory={memory} />
      {error && <ErrorNotice message={error} />}
      <div className="memory-review-actions">
        <Button size="sm" disabled={busy} onClick={() => void act(true)}>
          <Check size={14} />
          {memory.replaces_id ? "确认更新" : "记住"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void act(false)}
        >
          忽略
        </Button>
      </div>
    </article>
  );
}

export function MemorySavedNotice({
  notice,
  refresh,
  onClose,
}: {
  notice: MemoryNotice;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (busy || paused || error) return;
    const timer = setTimeout(onClose, 8000);
    return () => clearTimeout(timer);
  }, [busy, paused, error, onClose]);
  async function undo() {
    setBusy(true);
    try {
      await api(`/memory-changes/${notice.change_id}/undo`, "POST");
      await refresh();
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="memory-saved-notice"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPaused(false);
      }}
    >
      <div className="memory-saved-row">
        <span role="status" title={notice.content}>
          <Bookmark size={16} aria-hidden="true" />
          {notice.action === "updated" ? "记忆已更新" : "已记住"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void undo()}
        >
          <Undo2 size={14} />
          撤销
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="关闭记忆提示"
          onClick={onClose}
        >
          <X size={14} />
        </Button>
      </div>
      {error && <ErrorNotice message={error} />}
    </div>
  );
}
