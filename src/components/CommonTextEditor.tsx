import { useEffect, useId, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/lib/api";
import {
  notifyCommonTextsChanged,
  useCommonTextsRevision,
  type CommonText,
  type TextCategory,
} from "@/lib/commonTexts";
import {
  documentFor,
  documentImages,
  documentText,
  draftBlocks,
  serializeBlocks,
  type CommonTextDocument,
  type DraftBlock,
  type CommonTextAsset,
} from "@/lib/commonTextDocument";
import { errorMessage } from "@/lib/utils";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { SoftSelect } from "./ui/soft-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ConfirmDelete, ErrorNotice } from "./common";
import { CommonTextDocumentEditor } from "./CommonTextDocumentEditor";
import "../styles/common-texts.css";
import "../styles/common-text-document.css";

/** One mounted editor owns one draft and the lifecycle of its new image assets. */
export function CommonTextEditor({
  value,
  initialContent = "",
  initialDocument,
  initialCategory,
  initialAssets = [],
  onClose,
  onSaved,
}: {
  value?: CommonText;
  initialContent?: string;
  initialDocument?: CommonTextDocument;
  initialCategory?: string;
  initialAssets?: string[];
  onClose: () => void;
  onSaved: (value: CommonText) => void;
}) {
  const [initial] = useState(
    () => initialDocument || documentFor(value || { content: initialContent }),
  );
  const [blocks, setBlocks] = useState(() => draftBlocks(initial));
  const currentBlocks = useRef(blocks);
  currentBlocks.current = blocks;
  const [category, setCategory] = useState(
    value?.category_id || initialCategory || "uncategorized",
  );
  const initialGroup = useRef(category);
  const [categories, setCategories] = useState<TextCategory[]>([]);
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  const [error, setError] = useState(""),
    [fieldError, setFieldError] = useState("");
  const [saving, setSaving] = useState(false),
    [editingBusy, setEditingBusy] = useState(false),
    [discard, setDiscard] = useState(false);
  const [history, setHistory] = useState<DraftBlock[][]>([]),
    [redo, setRedo] = useState<DraftBlock[][]>([]);
  const [reload, setReload] = useState(0),
    revision = useCommonTextsRevision();
  const mounted = useRef(false),
    lock = useRef(false);
  const staged = useRef(new Set(initialAssets)),
    retained = useRef(new Set<string>());
  const typing = useRef({ key: "", time: 0 });
  const leave = useRef<(() => void) | undefined>(undefined);
  const closeRequest = useRef(() => {});
  const id = useId();
  const [owner] = useState(() => crypto.randomUUID());
  useEffect(() => {
    const request = (event: Event) => {
      leave.current = (event as CustomEvent<() => void>).detail;
      closeRequest.current();
    };
    window.addEventListener("xiaoxi-common-text-request-close", request);
    return () =>
      window.removeEventListener("xiaoxi-common-text-request-close", request);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const selection = isTauri() && getCurrentWindow().label === "selection";
    if (selection)
      void invoke("selection_editing", { editing: true, owner }).catch(
        () => {},
      );
    return () => {
      mounted.current = false;
      if (selection)
        setTimeout(() => {
          if (!mounted.current)
            void invoke("selection_editing", { editing: false, owner }).catch(
              () => {},
            );
        }, 0);
      // StrictMode replays setup before this task. Only a real unmount disposes assets.
      setTimeout(() => {
        if (!mounted.current)
          for (const key of staged.current)
            if (!retained.current.has(key))
              void api(`/common-text-assets/${key}`, "DELETE").catch(() => {});
      }, 0);
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
  function change(next: DraftBlock[], group = "") {
    if (!next.length)
      next = [{ key: crypto.randomUUID(), type: "text", text: "" }];
    const now = performance.now(),
      before = currentBlocks.current;
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    if (
      !group ||
      typing.current.key !== group ||
      now - typing.current.time > 750
    )
      setHistory((h) => [...h.slice(-99), before]);
    typing.current = { key: group, time: now };
    setRedo([]);
    currentBlocks.current = next;
    setBlocks(next);
    setFieldError("");
  }
  function undo() {
    if (!history.length || saving || editingBusy) return;
    typing.current.key = "";
    setRedo((r) => [...r, blocks]);
    setBlocks(history.at(-1)!);
    setHistory((h) => h.slice(0, -1));
  }
  function redoAction() {
    if (!redo.length || saving || editingBusy) return;
    typing.current.key = "";
    setHistory((h) => [...h, blocks]);
    setBlocks(redo.at(-1)!);
    setRedo((r) => r.slice(0, -1));
  }
  const document = serializeBlocks(blocks),
    content = documentText(document);
  const dirty =
    JSON.stringify(document) !== JSON.stringify(initial) ||
    category !== initialGroup.current ||
    initialAssets.length > 0;
  function finishClose() {
    const next = leave.current;
    leave.current = undefined;
    onClose();
    next?.();
  }
  function close() {
    if (lock.current || editingBusy) {
      leave.current = undefined;
      return;
    }
    if (dirty) setDiscard(true);
    else finishClose();
  }
  closeRequest.current = close;
  async function save() {
    if (lock.current || editingBusy || loading || loadError) return;
    if (
      (!content.trim() && !documentImages(document).length) ||
      content.length > 50000
    ) {
      setFieldError(
        content.length > 50000
          ? "正文不能超过 50,000 字符"
          : "请输入文字或添加图片",
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
          document,
          category_id: category === "uncategorized" ? null : category,
          expected_updated_at: value?.updated_at,
        },
      );
      retained.current = new Set(documentImages(documentFor(saved)));
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
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent
          className="common-text-editor common-text-rich-editor"
          showCloseButton={!saving && !editingBusy}
        >
          <DialogHeader>
            <DialogTitle>{value ? "编辑常用文本" : "新增常用文本"}</DialogTitle>
            <DialogDescription>保存文字和图片，按分类整理。</DialogDescription>
          </DialogHeader>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={saving}>
              <Label>正文</Label>
              <CommonTextDocumentEditor
                blocks={blocks}
                onChange={change}
                disabled={saving}
                onAssetCreated={(asset: CommonTextAsset) =>
                  staged.current.add(asset.id)
                }
                onBusyChange={setEditingBusy}
                onUndo={undo}
                onRedo={redoAction}
                canUndo={Boolean(history.length)}
                canRedo={Boolean(redo.length)}
              />
              {fieldError && (
                <p className="common-text-field-error" role="alert">
                  {fieldError}
                </p>
              )}
              <Label htmlFor={`${id}-category`}>分类</Label>
              <SoftSelect
                id={`${id}-category`}
                label="文本分类"
                value={category}
                onValueChange={setCategory}
                disabled={loading || Boolean(loadError) || editingBusy}
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
                disabled={saving || editingBusy}
                onClick={close}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  saving || editingBusy || loading || Boolean(loadError)
                }
              >
                {saving ? "保存中…" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        open={discard}
        title="放弃尚未保存的内容？"
        description="这次新增的文字、图片和修改将不会保存。"
        label="放弃修改"
        onClose={() => {
          leave.current = undefined;
          setDiscard(false);
        }}
        onConfirm={async () => finishClose()}
      />
    </>
  );
}
