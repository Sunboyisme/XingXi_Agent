import { useEffect, useId, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  notifyCommonTextsChanged,
  useCommonTextsRevision,
  type CommonText,
  type TextCategory,
} from "@/lib/commonTexts";
import { errorMessage } from "@/lib/utils";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { SoftSelect } from "./ui/soft-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ErrorNotice } from "./common";
import "../styles/common-texts.css";

/** Mount one editor per draft so late saves cannot close or overwrite a later draft. */
export function CommonTextEditor({
  value,
  initialContent = "",
  initialCategory,
  onClose,
  onSaved,
}: {
  value?: CommonText;
  initialContent?: string;
  initialCategory?: string;
  onClose: () => void;
  onSaved: (value: CommonText) => void;
}) {
  const [content, setContent] = useState(value?.content ?? initialContent);
  const [category, setCategory] = useState(
    value?.category_id || initialCategory || "uncategorized",
  );
  const [categories, setCategories] = useState<TextCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const revision = useCommonTextsRevision();
  const mounted = useRef(false);
  const lock = useRef(false);
  const id = useId();
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
      .then((rows) => {
        if (!controller.signal.aborted) setCategories(rows);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, revision]);
  async function save() {
    if (lock.current || loading || loadError) return;
    if (!content.trim() || content.length > 50000) {
      setFieldError(
        !content.trim() ? "请输入正文" : "正文不能超过 50,000 字符",
      );
      return;
    }
    if (
      category !== "uncategorized" &&
      !categories.some((row) => row.id === category)
    ) {
      setError("原分类已删除，请重新选择分类后保存。");
      return;
    }
    lock.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await api<CommonText>(
        value ? `/common-texts/${value.id}` : "/common-texts",
        value ? "PUT" : "POST",
        {
          content,
          category_id: category === "uncategorized" ? null : category,
        },
      );
      notifyCommonTextsChanged();
      if (mounted.current) onSaved(saved);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !lock.current) onClose();
      }}
    >
      <DialogContent className="common-text-editor" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{value ? "编辑常用文本" : "新增常用文本"}</DialogTitle>
          <DialogDescription>
            保存经常使用的文字，按分类整理，随时复制。
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={saving}>
            <Label htmlFor={`${id}-content`}>正文</Label>
            <Textarea
              id={`${id}-content`}
              rows={9}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setFieldError("");
              }}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={fieldError ? `${id}-error` : undefined}
              placeholder="输入要保存的文字"
            />
            {fieldError && (
              <p
                id={`${id}-error`}
                className="common-text-field-error"
                role="alert"
              >
                {fieldError}
              </p>
            )}
            <Label htmlFor={`${id}-category`}>分类</Label>
            <SoftSelect
              id={`${id}-category`}
              label="文本分类"
              value={category}
              onValueChange={setCategory}
              disabled={loading || Boolean(loadError)}
              options={[
                { value: "uncategorized", label: "默认分类" },
                ...(category !== "uncategorized" &&
                !categories.some((row) => row.id === category)
                  ? [
                      {
                        value: category,
                        label: "原分类已删除，请重新选择",
                        disabled: true,
                      },
                    ]
                  : []),
                ...categories.map((row) => ({
                  value: row.id,
                  label: row.name,
                })),
              ]}
            />
          </fieldset>
          {loading && <p role="status">正在读取分类…</p>}
          {loadError && (
            <ErrorNotice
              message={loadError}
              retry={() => setReload((n) => n + 1)}
            />
          )}
          {error && <ErrorNotice message={error} />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={saving || loading || Boolean(loadError)}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
