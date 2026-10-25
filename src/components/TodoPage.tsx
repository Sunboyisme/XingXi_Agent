import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  Check,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { zonedInput, zonedISO } from "@/lib/calendarMonth";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { DateTimePicker } from "./DateTimePicker";
import { ConfirmDelete, ErrorNotice, Toast } from "./common";

type Todo = {
  id: string;
  title: string;
  notes: string;
  status: string;
  reminder_at: string | null;
  timezone: string;
};
export function TodoPage({
  timezone,
  onCalendar,
  openId,
  onOpened,
  refresh,
}: {
  timezone: string;
  onCalendar: (view: "month" | "week") => void;
  openId?: string;
  onOpened?: () => void;
  refresh: () => Promise<void>;
}) {
  const [items, setItems] = useState<Todo[]>([]);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [editor, setEditor] = useState(false);
  const [editing, setEditing] = useState<Todo | null>(null);
  const [deleting, setDeleting] = useState<Todo | null>(null);
  const [form, setForm] = useState({
    title: "",
    notes: "",
    reminder: "",
    zone: timezone,
  });
  const load = useCallback(async () => {
    setItems(await api<Todo[]>("/todos?status=all"));
  }, []);
  useEffect(() => {
    let live = true;
    api<Todo[]>("/todos?status=all")
      .then((rows) => {
        if (live) setItems(rows);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  function edit(row?: Todo) {
    setError("");
    setEditing(row || null);
    setForm({
      title: row?.title || "",
      notes: row?.notes || "",
      reminder: row?.reminder_at
        ? zonedInput(row.reminder_at, row.timezone)
        : "",
      zone: row?.timezone || timezone,
    });
    setEditor(true);
  }
  useEffect(() => {
    if (!openId) return;
    let live = true;
    api<Todo>(`/todos/${openId}`)
      .then((row) => {
        if (live) {
          setCompleted(row.status === "completed");
          edit(row);
        }
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) onOpened?.();
      });
    return () => {
      live = false;
    };
  }, [openId]);
  async function perform(operation: () => Promise<unknown>, message: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      setEditor(false);
      setDeleting(null);
      setNotice(message);
      await load();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="todo-page page-content">
      <div className="plan-toolbar">
        <div className="plan-heading">
          <h1>待办</h1>
          <p>先记下来，在合适的时候提醒你。</p>
        </div>
        <div className="plan-toolbar-actions">
          <div
            className="calendar-view-switch"
            role="group"
            aria-label="计划视图"
          >
            <button aria-pressed="true">待办</button>
            <button aria-pressed="false" onClick={() => onCalendar("month")}>
              日历
            </button>
            <button aria-pressed="false" onClick={() => onCalendar("week")}>
              周历
            </button>
          </div>
          <Button onClick={() => edit()}>
            <Plus size={16} />
            新增待办
          </Button>
        </div>
      </div>
      {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      {error && !editor && (
        <ErrorNotice message={error} onClose={() => setError("")} />
      )}
      <div className="segmented todo-filters">
        <button
          aria-pressed={!completed}
          className={!completed ? "selected" : ""}
          onClick={() => setCompleted(false)}
        >
          未完成
        </button>
        <button
          aria-pressed={completed}
          className={completed ? "selected" : ""}
          onClick={() => setCompleted(true)}
        >
          已完成
        </button>
      </div>
      {loading && (
        <p role="status">
          <Loader2 size={16} className="spin" />
          正在读取待办…
        </p>
      )}
      {!loading &&
        !items.some((row) => (row.status === "completed") === completed) && (
          <p className="module-empty">
            {completed
              ? "还没有已完成的待办"
              : "没有未完成的待办，想到什么都可以先记下来。"}
          </p>
        )}
      <div className="todo-list">
        {items
          .filter((row) => (row.status === "completed") === completed)
          .map((row) => (
            <article
              className={`todo-row ${completed ? "is-completed" : ""}`}
              key={row.id}
            >
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                aria-label={`${completed ? "恢复" : "完成"}${row.title}`}
                onClick={() =>
                  void perform(
                    () =>
                      api(`/todos/${row.id}/action`, "POST", {
                        action: completed ? "restore" : "complete",
                      }),
                    completed ? "待办已恢复" : "待办已完成",
                  )
                }
              >
                {completed ? <RotateCcw size={19} /> : <Check size={19} />}
              </Button>
              <button className="todo-row-copy" onClick={() => edit(row)}>
                <strong>{row.title}</strong>
                {row.notes && <span>{row.notes}</span>}
                {row.reminder_at && (
                  <small>
                    <Bell size={13} />
                    {new Date(row.reminder_at).toLocaleString("zh-CN", {
                      timeZone: row.timezone,
                    })}
                    {Date.parse(row.reminder_at) <= Date.now()
                      ? " · 已到提醒时间"
                      : ""}
                  </small>
                )}
              </button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`编辑${row.title}`}
                onClick={() => edit(row)}
              >
                <Pencil size={15} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                aria-label={`删除${row.title}`}
                onClick={() => setDeleting(row)}
              >
                <Trash2 size={15} />
              </Button>
            </article>
          ))}
      </div>
      <Dialog
        open={editor}
        onOpenChange={(value) => {
          if (!busy) setEditor(value);
        }}
      >
        <DialogContent className="todo-editor">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑待办" : "新增待办"}</DialogTitle>
            <DialogDescription>
              待办不参与日历排期，提醒时间可留空。
            </DialogDescription>
          </DialogHeader>
          <label>
            待办名称
            <Input
              value={form.title}
              maxLength={300}
              disabled={busy}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              autoFocus
            />
          </label>
          <label>
            备注
            <Textarea
              value={form.notes}
              maxLength={6000}
              disabled={busy}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </label>
          <label>
            提醒时间（可选）
            <DateTimePicker
              id="todo-reminder"
              label="待办提醒时间"
              value={form.reminder}
              disabled={busy || editing?.status === "completed"}
              onChange={(reminder) => setForm({ ...form, reminder })}
            />
          </label>
          {form.reminder && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setForm({ ...form, reminder: "" })}
            >
              取消提醒
            </Button>
          )}
          {error && <ErrorNotice message={error} />}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setEditor(false)}
            >
              取消
            </Button>
            <Button
              disabled={busy || !form.title.trim()}
              onClick={() =>
                void perform(
                  () =>
                    api(
                      editing ? `/todos/${editing.id}` : "/todos",
                      editing ? "PUT" : "POST",
                      {
                        title: form.title,
                        notes: form.notes,
                        timezone: form.zone,
                        reminder_at: form.reminder
                          ? editing?.reminder_at &&
                            form.reminder ===
                              zonedInput(editing.reminder_at, editing.timezone)
                            ? editing.reminder_at
                            : zonedISO(form.reminder, form.zone)
                          : null,
                      },
                    ),
                  "待办已保存",
                )
              }
            >
              {busy && <Loader2 size={15} className="spin" />}
              {busy ? "正在保存…" : "保存待办"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        open={Boolean(deleting)}
        title="删除这条待办？"
        description="待办及其待触发提醒会一并移除。"
        label="删除待办"
        error={error}
        onClose={() => {
          if (!busy) setDeleting(null);
        }}
        onConfirm={() =>
          deleting
            ? perform(
                () => api(`/todos/${deleting.id}`, "DELETE"),
                "待办已删除",
              )
            : Promise.resolve()
        }
      />
    </div>
  );
}
