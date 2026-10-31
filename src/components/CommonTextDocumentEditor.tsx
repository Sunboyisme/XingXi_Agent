import { useEffect, useId, useRef, useState } from "react";
import {
  GripVertical,
  ImagePlus,
  Plus,
  Pencil,
  Trash2,
  Undo2,
  Redo2,
} from "lucide-react";
import { api } from "@/lib/api";
import { nativeFile, useNativeDrop } from "@/lib/nativeDrop";
import { usePointerReorder } from "@/lib/usePointerReorder";
import {
  uploadCommonTextImage,
  type CommonTextAsset,
  type DraftBlock,
} from "@/lib/commonTextDocument";
import { errorMessage } from "@/lib/utils";
import { CommonTextPicture } from "./CommonTextContent";
import { CommonTextImageEditor } from "./CommonTextImageEditor";
import { Button } from "./ui/button";
import { ErrorNotice } from "./common";

type Anchor = { key: string; start: number; end: number };
export function CommonTextDocumentEditor({
  blocks,
  onChange,
  onAssetCreated,
  onBusyChange,
  disabled,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: {
  blocks: DraftBlock[];
  onChange: (blocks: DraftBlock[], group?: string) => void;
  onAssetCreated: (asset: CommonTextAsset) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const [uploading, setUploading] = useState(false),
    [error, setError] = useState("");
  const [editing, setEditing] = useState<{ key: string; assetId: string }>();
  const root = useRef<HTMLDivElement>(null),
    picker = useRef<HTMLInputElement>(null);
  const anchor = useRef<Anchor | undefined>(undefined);
  const lock = useRef(false),
    mounted = useRef(false),
    composing = useRef(false);
  const latest = useRef(blocks);
  latest.current = blocks;
  const scope = useId();
  const busy = uploading || Boolean(editing),
    inactive = disabled || busy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  const reorder = usePointerReorder(
    blocks.map((block) => block.key),
    (ids) => {
      const byKey = new Map(latest.current.map((block) => [block.key, block]));
      onChange(ids.map((key) => byKey.get(key)!));
    },
    inactive,
  );
  function locateDrop(position?: { x: number; y: number }) {
    if (!position || !root.current) return;
    const rows = [
      ...root.current.querySelectorAll<HTMLElement>("[data-sort-id]"),
    ];
    const index = rows.findIndex((row) => {
      const b = row.getBoundingClientRect();
      return position.y < b.top + b.height / 2;
    });
    const previous =
      index === 0
        ? undefined
        : blocks[index < 0 ? blocks.length - 1 : index - 1];
    anchor.current = previous
      ? {
          key: previous.key,
          start: previous.type === "text" ? previous.text.length : 0,
          end: previous.type === "text" ? previous.text.length : 0,
        }
      : { key: "before-first", start: 0, end: 0 };
  }
  async function addImages(files: File[]) {
    if (!files.length || lock.current || inactive) return;
    lock.current = true;
    setUploading(true);
    setError("");
    const at = anchor.current,
      created: CommonTextAsset[] = [];
    try {
      if (files.length > 4)
        throw new Error("每次最多添加 4 张图片，请分批添加");
      if (
        files.some(
          (file) =>
            !/\.(png|jpe?g|webp)$/i.test(file.name) &&
            !["image/png", "image/jpeg", "image/webp"].includes(file.type),
        )
      )
        throw new Error("请添加 PNG、JPG 或 WebP 图片");
      for (const file of files) {
        const asset = await uploadCommonTextImage(file);
        created.push(asset);
        if (!mounted.current) {
          void api(`/common-text-assets/${asset.id}`, "DELETE").catch(() => {});
          return;
        }
        onAssetCreated(asset);
      }
      const current = latest.current;
      const images: DraftBlock[] = created.map((asset) => ({
        key: crypto.randomUUID(),
        type: "image",
        asset_id: asset.id,
      }));
      const index = at
          ? current.findIndex((block) => block.key === at.key)
          : -1,
        block = current[index];
      let next: DraftBlock[];
      if (block?.type === "text" && at) {
        next = [
          ...current.slice(0, index),
          { ...block, text: block.text.slice(0, at.start) },
          ...images,
          {
            key: crypto.randomUUID(),
            type: "text",
            text: block.text.slice(at.end),
          },
          ...current.slice(index + 1),
        ];
      } else {
        const insertAt =
          at?.key === "before-first"
            ? 0
            : index < 0
              ? current.length
              : index + 1;
        next = [
          ...current.slice(0, insertAt),
          ...images,
          { key: crypto.randomUUID(), type: "text", text: "" },
          ...current.slice(insertAt),
        ];
      }
      onChange(next);
      anchor.current = undefined;
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setUploading(false);
    }
  }
  useNativeDrop(
    root,
    async (files, position) => {
      locateDrop(position);
      await addImages(files.map(nativeFile));
    },
    setError,
    false,
    inactive,
    scope,
  );
  return (
    <>
      <div
        className="common-document-editor"
        ref={root}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "z" &&
            !event.nativeEvent.isComposing &&
            !composing.current &&
            !inactive
          ) {
            event.preventDefault();
            event.stopPropagation();
            event.shiftKey ? onRedo() : onUndo();
          }
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          if (files.length) {
            event.preventDefault();
            void addImages(files);
          }
        }}
        onDragOver={(event) => {
          if (!inactive && event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            event.stopPropagation();
            locateDrop({ x: event.clientX, y: event.clientY });
            void addImages(Array.from(event.dataTransfer.files));
          }
        }}
      >
        <div className="common-document-toolbar">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={inactive}
            onClick={() => picker.current?.click()}
          >
            <ImagePlus size={15} />
            添加图片
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={inactive}
            onClick={() =>
              onChange([
                ...blocks,
                { key: crypto.randomUUID(), type: "text", text: "" },
              ])
            }
          >
            <Plus size={15} />
            添加文字
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="撤销图文修改"
            disabled={inactive || !canUndo}
            onClick={onUndo}
          >
            <Undo2 size={15} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="重做图文修改"
            disabled={inactive || !canRedo}
            onClick={onRedo}
          >
            <Redo2 size={15} />
          </Button>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              event.target.value = "";
              void addImages(files);
            }}
          />
        </div>
        <div className="common-document-blocks" data-reorder-list>
          {reorder.order.map((key) => {
            const block = blocks.find((value) => value.key === key)!;
            return (
              <div
                className="common-document-block"
                key={key}
                data-sort-id={key}
                data-dragging={reorder.dragging === key || undefined}
              >
                <button
                  type="button"
                  className="common-block-grip"
                  aria-label="调整段落或图片顺序"
                  disabled={inactive}
                  {...reorder.handle(key)}
                >
                  <GripVertical size={16} />
                </button>
                <div className="common-block-body">
                  {block.type === "text" ? (
                    <textarea
                      aria-label="文字段落"
                      placeholder="输入文字，或粘贴、拖入图片"
                      value={block.text}
                      disabled={inactive}
                      rows={Math.min(
                        12,
                        Math.max(2, block.text.split("\n").length),
                      )}
                      onSelect={(event) => {
                        anchor.current = {
                          key,
                          start: event.currentTarget.selectionStart,
                          end: event.currentTarget.selectionEnd,
                        };
                      }}
                      onChange={(event) =>
                        onChange(
                          blocks.map((value) =>
                            value.key === key
                              ? { ...block, text: event.target.value }
                              : value,
                          ),
                          key,
                        )
                      }
                    />
                  ) : (
                    <CommonTextPicture id={block.asset_id}>
                      {(asset) => (
                        <>
                          <button
                            type="button"
                            disabled={inactive}
                            onClick={() =>
                              setEditing({ key, assetId: asset.id })
                            }
                          >
                            <Pencil size={14} />
                            {asset.scene ? "重新编辑标注" : "编辑图片"}
                          </button>
                          <button
                            type="button"
                            disabled={inactive}
                            data-delete-action
                            onClick={() =>
                              onChange(
                                blocks.filter((value) => value.key !== key),
                              )
                            }
                          >
                            <Trash2 size={14} />
                            移除图片
                          </button>
                        </>
                      )}
                    </CommonTextPicture>
                  )}
                </div>
                {block.type === "text" && blocks.length > 1 && (
                  <button
                    type="button"
                    className="common-block-remove"
                    aria-label="移除文字段落"
                    data-delete-action
                    disabled={inactive}
                    onClick={() =>
                      onChange(blocks.filter((value) => value.key !== key))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {uploading && <p role="status">正在添加图片…</p>}
        {error && <ErrorNotice message={error} />}
      </div>
      {editing && (
        <CommonTextImageEditor
          key={editing.assetId}
          assetId={editing.assetId}
          onClose={() => setEditing(undefined)}
          onSaved={(asset) => {
            onAssetCreated(asset);
            onChange(
              latest.current.map((block) =>
                block.key === editing.key
                  ? { ...block, type: "image", asset_id: asset.id }
                  : block,
              ),
            );
            setEditing(undefined);
          }}
        />
      )}
    </>
  );
}
