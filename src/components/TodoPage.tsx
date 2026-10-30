import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  GripVertical,
  ListPlus,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { zonedInput, zonedISO } from "@/lib/calendarMonth";
import { Button } from "./ui/button";
import { PlanCompletionButton, PlanViewSwitch } from "./PlanControls";
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
import { ConfirmDelete, ErrorNotice, Hint, Toast } from "./common";
import { errorMessage } from "@/lib/utils";

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
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const targetRef = useRef<string | null>(null);
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
      .catch((e) => {
        if (live) setError(errorMessage(e));
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
      .catch((e) => {
        if (live) setError(errorMessage(e));
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
      await Promise.all([load(), refresh()]).catch(() =>
        setError("已保存，列表暂未刷新，请稍后重试。"),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function moveTodo(id: string, target: string) {
    if (id === target || lock.current) return;
    const visible = items.filter(
      (row) => (row.status === "completed") === completed,
    );
    const from = visible.findIndex((row) => row.id === id);
    const to = visible.findIndex((row) => row.id === target);
    if (from < 0 || to < 0) return;
    visible.splice(to, 0, visible.splice(from, 1)[0]);
    const previous = items;
    let index = 0;
    setItems(
      items.map((row) =>
        (row.status === "completed") === completed ? visible[index++] : row,
      ),
    );
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api("/todos/reorder", "POST", {
        ids: visible.map((row) => row.id),
        status: completed ? "completed" : "active",
      });
      setNotice("待办顺序已保存");
    } catch (error) {
      setItems(previous);
      setError(errorMessage(error));
      await load().catch(() => {});
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="calendar-page todo-page page-content calendar-compact-page">
      <div className="plan-toolbar">
        <div className="plan-heading">
          <h1>待办</h1>
        </div>
        <div className="plan-toolbar-actions">
          <PlanViewSwitch
            value="todo"
            onChange={(view) => {
              if (view !== "todo") onCalendar(view);
            }}
          />
          <Button
            size="sm"
            className="plan-add-trigger"
            disabled={busy}
            onClick={() => edit()}
          >
            <ListPlus size={16} />
            <span>添加待办</span>
          </Button>
        </div>
      </div>
      <div className="todo-scroll">
        {notice && <Toast message={notice} onClose={() => setNotice("")} />}
        {error && !editor && (
          <ErrorNotice message={error} onClose={() => setError("")} />
        )}
        <div className="segmented todo-filters">
          <button
            disabled={busy || Boolean(dragging)}
            aria-pressed={!completed}
            className={!completed ? "selected" : ""}
            onClick={() => setCompleted(false)}
          >
            未完成
          </button>
          <button
            disabled={busy || Boolean(dragging)}
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
                className={`todo-row ${completed ? "is-completed" : ""} ${dragging === row.id ? "is-dragging" : ""} ${dropTarget === row.id && dragging !== row.id ? "is-drop-target" : ""}`}
                key={row.id}
                data-todo-id={row.id}
              >
                <Hint label="拖动排序，也可聚焦后按上下方向键调整">
                <button
                  type="button"
                  className="todo-drag-handle"
                  disabled={busy}
                  aria-label={`排序${row.title}`}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || busy) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragging(row.id);
                    setDropTarget(row.id);
                    targetRef.current = row.id;
                  }}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId))
                      return;
                    const target = document
                      .elementFromPoint(event.clientX, event.clientY)
                      ?.closest<HTMLElement>("[data-todo-id]")?.dataset.todoId;
                    targetRef.current = target ?? null;
                    setDropTarget(target ?? null);
                    const container =
                      event.currentTarget.closest<HTMLElement>(".todo-scroll");
                    if (container) {
                      const rect = container.getBoundingClientRect();
                      if (event.clientY < rect.top + 48)
                        container.scrollBy(0, -20);
                      if (event.clientY > rect.bottom - 48)
                        container.scrollBy(0, 20);
                    }
                  }}
                  onPointerUp={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId))
                      return;
                    const target = targetRef.current;
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    setDragging(null);
                    setDropTarget(null);
                    targetRef.current = null;
                    if (target) void moveTodo(row.id, target);
                  }}
                  onLostPointerCapture={() => {
                    setDragging(null);
                    setDropTarget(null);
                    targetRef.current = null;
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                      return;
                    event.preventDefault();
                    const visible = items.filter(
                      (item) => (item.status === "completed") === completed,
                    );
                    const next =
                      visible[
                        visible.findIndex((item) => item.id === row.id) +
                          (event.key === "ArrowUp" ? -1 : 1)
                      ];
                    if (next) void moveTodo(row.id, next.id);
                  }}
                >
                  <GripVertical size={17} />
                </button>
                </Hint>
                <PlanCompletionButton
                  status={row.status}
                  disabled={busy}
                  label={`${completed ? "恢复" : "完成"}${row.title}`}
                  onClick={() =>
                    void perform(
                      () =>
                        api(`/todos/${row.id}/action`, "POST", {
                          action: completed ? "restore" : "complete",
                        }),
                      completed ? "待办已恢复" : "待办已完成",
                    )
                  }
                />
                <button
                  className="todo-row-copy"
                  disabled={busy}
                  onClick={() => edit(row)}
                >
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
                  disabled={busy}
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
          <label htmlFor="todo-title">
            待办名称
            <Input
              id="todo-title"
              value={form.title}
              maxLength={300}
              disabled={busy}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              autoFocus
            />
          </label>
          <label htmlFor="todo-notes">
            备注
            <Textarea
              id="todo-notes"
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
