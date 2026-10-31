import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Gapcursor, UndoRedo, TrailingNode } from "@tiptap/extensions";
import { ImagePlus, Undo2, Redo2 } from "lucide-react";
import { api } from "@/lib/api";
import { nativeFile, useNativeDrop } from "@/lib/nativeDrop";
import {
  uploadCommonTextImage,
  type CommonTextAsset,
  type CommonTextDocument,
} from "@/lib/commonTextDocument";
import { commonTextToProse, proseToCommonText } from "@/lib/commonTextProse";
import { errorMessage } from "@/lib/utils";
import {
  CommonTextImageContext,
  CommonTextImageNode,
} from "./CommonTextImageNode";
import { CommonTextImageEditor } from "./CommonTextImageEditor";
import { Button } from "./ui/button";
import { ErrorNotice } from "./common";

type ImageEdit = { assetId: string; getPos: () => number | undefined };
type Point = { x: number; y: number };
const extensions = [
  Document,
  Gapcursor,
  HardBreak,
  UndoRedo,
  Paragraph,
  Text,
  TrailingNode,
  CommonTextImageNode,
];

/** ProseMirror owns one contenteditable surface, including its caret, IME and history. */
export function CommonTextDocumentEditor({
  document,
  onChange,
  onAssetCreated,
  onBusyChange,
  disabled,
}: {
  document: CommonTextDocument;
  onChange: (document: CommonTextDocument) => void;
  onAssetCreated: (asset: CommonTextAsset) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
}) {
  const [initialContent] = useState(() => commonTextToProse(document));
  const [readingFiles, setReadingFiles] = useState(false);
  const nativeReading = useRef(false);
  const nativeRange = useRef<{ from: number; to: number } | null>(null);
  const [uploading, setUploading] = useState(false),
    [error, setError] = useState("");
  const [editing, setEditing] = useState<ImageEdit>();
  const surface = useRef<HTMLDivElement>(null),
    picker = useRef<HTMLInputElement>(null);
  const lock = useRef(false),
    mounted = useRef(false);
  const scope = useId();
  const dropInactive = disabled || uploading || Boolean(editing);
  const busy = readingFiles || uploading || Boolean(editing),
    inactive = disabled || busy;
  const latest = useRef({
    onChange,
    onAssetCreated,
    onBusyChange,
    disabled,
    inactive,
  });
  latest.current = {
    onChange,
    onAssetCreated,
    onBusyChange,
    disabled,
    inactive,
  };
  const actions = useRef({
    addImages: (_files: File[], _position?: Point) => {},
    edit: (_assetId: string, _getPos: () => number | undefined) => {},
  });
  const editor = useEditor({
    extensions,
    content: initialContent,
    editable: !disabled,
    shouldRerenderOnTransaction: false,
    onUpdate: ({ editor: current }) =>
      latest.current.onChange(proseToCommonText(current.getJSON())),
    editorProps: {
      attributes: {
        class: "common-document-prose",
        role: "textbox",
        "aria-label": "正文",
        "aria-multiline": "true",
        spellcheck: "false",
      },
      handleKeyDown: (_view, event) => {
        if (
          (latest.current.inactive || nativeReading.current || lock.current) &&
          (["Backspace", "Delete", "Enter"].includes(event.key) ||
            ((event.ctrlKey || event.metaKey) &&
              ["x", "v", "z", "y"].includes(event.key.toLowerCase())))
        ) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.items || [])
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file));
        if (!files.length) return false;
        event.preventDefault();
        actions.current.addImages(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) return false;
        event.preventDefault();
        actions.current.addImages(files, {
          x: event.clientX,
          y: event.clientY,
        });
        return true;
      },
    },
  });
  const toolbar = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      undo: current?.can().undo() || false,
      redo: current?.can().redo() || false,
      empty: current?.isEmpty ?? true,
    }),
  });
  const imageContext = useMemo(
    () => ({
      inactive,
      edit: (assetId: string, getPos: () => number | undefined) =>
        actions.current.edit(assetId, getPos),
    }),
    [inactive],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useLayoutEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!inactive, false);
  }, [editor, inactive]);

  async function addImages(
    files: File[],
    position?: Point,
    fromNative = false,
  ) {
    if (
      !files.length ||
      !editor ||
      editor.isDestroyed ||
      lock.current ||
      latest.current.disabled ||
      Boolean(editing) ||
      (nativeReading.current && !fromNative)
    )
      return;
    if (editor.view.composing) {
      setError("请先完成正在输入的文字，再添加图片。");
      return;
    }
    const drop = position
      ? editor.view.posAtCoords({ left: position.x, top: position.y })
      : null;
    const range =
      fromNative && nativeRange.current
        ? nativeRange.current
        : drop
          ? { from: drop.pos, to: drop.pos }
          : {
              from: editor.state.selection.from,
              to: editor.state.selection.to,
            };
    lock.current = true;
    editor.setEditable(false, false);
    setUploading(true);
    setError("");
    latest.current.onBusyChange(true);
    const created: CommonTextAsset[] = [];
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
        if (!mounted.current || editor.isDestroyed) {
          void api(`/common-text-assets/${asset.id}`, "DELETE").catch(() => {});
          return;
        }
        latest.current.onAssetCreated(asset);
      }
      const inserted = editor.commands.insertContentAt(
        range,
        created.map((asset) => ({
          type: "commonTextImage",
          attrs: { assetId: asset.id },
        })),
      );
      if (!inserted)
        throw new Error("图片插入失败，正文已保留，请重新选择插入位置。");
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      lock.current = false;
      if (mounted.current && !editor.isDestroyed) {
        setUploading(false);
        latest.current.onBusyChange(nativeReading.current);
        editor.setEditable(
          !latest.current.disabled && !nativeReading.current,
          false,
        );
        editor.commands.focus();
      }
    }
  }
  actions.current.addImages = (files, position) => {
    void addImages(files, position);
  };
  actions.current.edit = (assetId, getPos) => {
    if (
      !editor ||
      editor.isDestroyed ||
      latest.current.inactive ||
      lock.current
    )
      return;
    editor.setEditable(false, false);
    latest.current.onBusyChange(true);
    setEditing({ assetId, getPos });
  };
  useNativeDrop(
    surface,
    async (files, position) => {
      await addImages(files.map(nativeFile), position, true);
    },
    setError,
    false,
    dropInactive,
    scope,
    (reading, position) => {
      nativeReading.current = reading;
      setReadingFiles(reading);
      if (reading && editor && !editor.isDestroyed) {
        const hit = position
          ? editor.view.posAtCoords({ left: position.x, top: position.y })
          : null;
        nativeRange.current = hit
          ? { from: hit.pos, to: hit.pos }
          : {
              from: editor.state.selection.from,
              to: editor.state.selection.to,
            };
      }
      if (!reading) nativeRange.current = null;
      latest.current.onBusyChange(reading || lock.current || Boolean(editing));
      if (editor && !editor.isDestroyed)
        editor.setEditable(
          !reading && !lock.current && !editing && !latest.current.disabled,
          false,
        );
    },
  );
  return (
    <>
      <div className="common-document-editor">
        <div className="common-document-toolbar">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={inactive || !editor}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => picker.current?.click()}
          >
            <ImagePlus size={15} />
            添加图片
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="撤销图文修改"
            disabled={inactive || !toolbar?.undo}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor?.chain().focus().undo().run()}
          >
            <Undo2 size={15} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="重做图文修改"
            disabled={inactive || !toolbar?.redo}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor?.chain().focus().redo().run()}
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
        <div
          ref={surface}
          className="common-document-surface"
          data-empty={toolbar?.empty || undefined}
        >
          <CommonTextImageContext.Provider value={imageContext}>
            <EditorContent editor={editor} />
          </CommonTextImageContext.Provider>
        </div>
        {(readingFiles || uploading) && (
          <p role="status">{uploading ? "正在添加图片…" : "正在读取图片…"}</p>
        )}
        {error && <ErrorNotice message={error} />}
      </div>
      {editing && (
        <CommonTextImageEditor
          key={editing.assetId}
          assetId={editing.assetId}
          onClose={() => setEditing(undefined)}
          onSaved={(asset) => {
            latest.current.onAssetCreated(asset);
            const position = editing.getPos();
            if (
              editor &&
              !editor.isDestroyed &&
              position !== undefined &&
              editor.state.doc.nodeAt(position)?.attrs.assetId ===
                editing.assetId
            ) {
              editor.commands.command(({ tr }) => {
                tr.setNodeMarkup(position, undefined, { assetId: asset.id });
                return true;
              });
            } else
              setError("原图片已变化，当前正文已保留，请重新打开图片编辑。");
            setEditing(undefined);
          }}
        />
      )}
    </>
  );
}
