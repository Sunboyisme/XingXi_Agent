import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  notifyCommonTextsChanged,
  useCommonTextsRevision,
  type TextCategory,
} from "@/lib/commonTexts";
import { errorMessage } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ConfirmDelete, ErrorNotice, Hint } from "./common";

export function TextCategoryManager({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<TextCategory[]>([]);
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<TextCategory>();
  const [deleteError, setDeleteError] = useState("");
  const [reload, setReload] = useState(0);
  const revision = useCommonTextsRevision();
  const lock = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void api<TextCategory[]>("/common-text-categories", "GET", undefined, {
      signal: controller.signal,
      timeoutMs: 10000,
    })
      .then((value) => {
        if (!controller.signal.aborted) setRows(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, reload]);
  async function save() {
    if (lock.current) return;
    if (!name.trim() || name.trim() === "未分类" || name.trim().length > 80) {
      setError("请输入 1–80 字符的分类名，不使用保留名称“未分类”。");
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api(
        editing
          ? `/common-text-categories/${editing}`
          : "/common-text-categories",
        editing ? "PUT" : "POST",
        { name: name.trim() },
      );
      notifyCommonTextsChanged();
      if (mounted.current) {
        setEditing(undefined);
        setName("");
        setReload((n) => n + 1);
      }
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !lock.current) onClose();
      }}
    >
      <DialogContent className="text-category-manager" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>管理分类</DialogTitle>
          <DialogDescription>
            删除分类后，已有文本会移入“未分类”。
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="text-category-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            aria-label={editing ? "重命名分类" : "新分类名称"}
            placeholder={editing ? "输入新的分类名称" : "新分类名称"}
            value={name}
            disabled={busy}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "category-save-error" : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />
          <Button disabled={busy} type="submit">
            {busy ? "保存中…" : editing ? "保存" : "新增"}
          </Button>
          {editing && (
            <Button
              variant="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(undefined);
                setName("");
                setError("");
              }}
            >
              取消
            </Button>
          )}
        </form>
        {error && (
          <p
            id="category-save-error"
            className="common-text-field-error"
            role="alert"
          >
            {error}
          </p>
        )}
        {loading && <p role="status">正在读取分类…</p>}
        {loadError && (
          <ErrorNotice
            message={loadError}
            retry={() => setReload((n) => n + 1)}
          />
        )}
        <ul className="text-category-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span>{row.name}</span>
              <Hint label="重命名分类">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`重命名${row.name}`}
                  disabled={busy}
                  onClick={() => {
                    setEditing(row.id);
                    setName(row.name);
                    setError("");
                  }}
                >
                  <Pencil size={15} />
                </Button>
              </Hint>
              <Hint label="删除分类">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`删除${row.name}`}
                  disabled={busy}
                  onClick={() => {
                    setDeleting(row);
                    setDeleteError("");
                  }}
                >
                  <Trash2 size={15} />
                </Button>
              </Hint>
            </li>
          ))}
        </ul>
        {!loading && !loadError && !rows.length && (
          <p className="common-text-muted">
            暂无分类，未分类文本仍可正常保存。
          </p>
        )}
        <ConfirmDelete
          open={Boolean(deleting)}
          title="删除分类？"
          description={`“${deleting?.name || ""}”中的文本将移入“未分类”，正文会保留。`}
          label="删除分类"
          error={deleteError}
          onClose={() => setDeleting(undefined)}
          onConfirm={async () => {
            if (!deleting || lock.current) return;
            lock.current = true;
            setBusy(true);
            setDeleteError("");
            try {
              await api(`/common-text-categories/${deleting.id}`, "DELETE");
              notifyCommonTextsChanged();
              if (mounted.current) {
                if (editing === deleting.id) {
                  setEditing(undefined);
                  setName("");
                }
                setDeleting(undefined);
                setReload((n) => n + 1);
              }
            } catch (cause) {
              if (mounted.current) setDeleteError(errorMessage(cause));
            } finally {
              lock.current = false;
              if (mounted.current) setBusy(false);
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
