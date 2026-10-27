import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ImagePlus, Loader2, RotateCw, X, FileText, Folder } from "lucide-react";
import { useNativeDrop, nativeFile } from "@/lib/nativeDrop";
import { isTauri } from "@tauri-apps/api/core";
import { Dialog, Tooltip } from "radix-ui";
import { createPortal } from "react-dom";
import {
  api,
  fetchApi,
  uploadImage,
  uploadFile,
  type Attachment,
} from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { Hint } from "./ui/hint";

const imageExtension = /\.(jpe?g|png|webp)$/i;
const documentExtension = /\.(docx|pdf|xlsx|txt|md|csv|json)$/i;
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const documentTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
]);
const maxImageBytes = 10 * 1024 * 1024;
const maxDocumentBytes = 20 * 1024 * 1024;

function isImageFile(file: Pick<File, "name" | "type">) {
  return imageTypes.has(file.type) || imageExtension.test(file.name);
}

function isDocumentFile(file: Pick<File, "name" | "type">) {
  return documentTypes.has(file.type) || documentExtension.test(file.name);
}

function clipboardImages(data: DataTransfer | null) {
  const files = Array.from(data?.items ?? [])
    .filter((item) => item.kind === "file" && imageTypes.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (files.length) return files;
  return Array.from(data?.files ?? []).filter(isImageFile);
}

export function Picture({
  id,
  name = "提交的图片",
}: {
  id: string;
  name?: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    setUrl("");
    setError(false);
    fetchApi(`/attachments/${id}/content`, { signal: controller.signal })
      .then((res) => res.blob())
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (alive) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      alive = false;
      clearTimeout(timeout);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, attempt]);
  if (error)
    return (
      <button
        type="button"
        className="image-load-error"
        onClick={() => setAttempt(attempt + 1)}
      >
        图片加载失败，重试
      </button>
    );
  if (!url) return <span className="image-loading">图片加载中</span>;
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="picture-trigger"
          aria-label={`放大 ${name}`}
        >
          <img
            src={url}
            alt={name}
            className="attachment-picture"
            onError={() => setError(true)}
          />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="picture-overlay" />
        <Dialog.Content className="picture-viewer" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{name}</Dialog.Title>
          <img src={url} alt={name} />
          <Dialog.Close className="picture-close" aria-label="关闭图片">
            <X size={22} />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Pending = {
  key: string;
  file: File;
  url: string;
  error: string;
  uploading: boolean;
  phase?: string;
  serverId?: string;
};
export function ImagesInput({
  images,
  onChange,
  disabled,
  onError,
  onUploading,
  dropTarget,
  previewTarget,
  previewMode = "thumbnails",
  allowFiles = false,
  scopeKey = "default",
  pickerRef,
  hideTrigger = false,
  allowFolders = false,
}: {
  images: Attachment[];
  onChange: (values: Attachment[]) => void;
  disabled?: boolean;
  onError: (message: string) => void;
  onUploading?: (value: boolean) => void;
  dropTarget?: RefObject<HTMLElement | null>;
  previewTarget?: RefObject<HTMLElement | null>;
  previewMode?: "thumbnails" | "names";
  allowFiles?: boolean;
  scopeKey?: string;
  pickerRef?: RefObject<HTMLInputElement | null>;
  hideTrigger?: boolean;
  allowFolders?: boolean;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const pendingRef = useRef<Pending[]>([]);
  const nativeReading = useRef(false);
  const localFileInput = useRef<HTMLInputElement>(null);
  const fileInput = pickerRef ?? localFileInput;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const generation = useRef(0);
  const fingerprints = useRef(new Map<string, string>());
  const callbacks = useRef({ onChange, onError, onUploading });
  callbacks.current = { onChange, onError, onUploading };
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  function update(values: Pending[]) {
    pendingRef.current = values;
    setPending(values);
    callbacks.current.onUploading?.(
      nativeReading.current || values.some((x) => x.uploading || (allowFiles && Boolean(x.error))),
    );
  }
  function reset() {
    generation.current++;
    nativeReading.current = false;
    pendingRef.current.forEach((x) => URL.revokeObjectURL(x.url));
    pendingRef.current = [];
    fingerprints.current.clear();
  }
  useEffect(() => {
    reset();
    setPending([]);
    callbacks.current.onUploading?.(false);
    return reset;
  }, [scopeKey]);
  useLayoutEffect(() => {
    // The preview slot is a ref on the composer; capture it after mount so
    // restored drafts render in the right place on the very first paint.
    setPortalTarget(previewTarget?.current ?? null);
  }, [previewTarget]);
  async function upload(item: Pending) {
    const epoch = generation.current;
    update(
      pendingRef.current.map((x) =>
        x.key === item.key ? { ...x, uploading: true, error: "" } : x,
      ),
    );
    try {
      const documentFile = allowFiles && isDocumentFile(item.file);
      let value: Attachment;
      if (documentFile) {
        value = item.serverId
          ? await api<Attachment>(`/files/${item.serverId}/retry`, "POST")
          : await uploadFile(item.file);
        if (generation.current !== epoch || !pendingRef.current.some((x) => x.key === item.key)) return;
        const id = value.id;
        update(
          pendingRef.current.map((x) =>
            x.key === item.key ? { ...x, serverId: id, phase: "解析中…" } : x,
          ),
        );
        const deadline = Date.now() + 90000;
        while (["queued", "parsing"].includes(value.file_status || "")) {
          if (
            generation.current !== epoch ||
            !pendingRef.current.some((x) => x.key === item.key)
          )
            return;
          if (Date.now() > deadline)
            throw new Error("解析尚未完成，请稍后重试");
          await new Promise((resolve) => setTimeout(resolve, 500));
          value = await api<Attachment>(`/files/${id}`);
        }
        if (value.file_status === "failed")
          throw new Error(value.error || "文件解析失败");
      } else value = await uploadImage(item.file);
      if (
        generation.current !== epoch ||
        !pendingRef.current.some((x) => x.key === item.key)
      )
        return;
      fingerprints.current.set(item.key, value.id);
      imagesRef.current = [...imagesRef.current, value];
      callbacks.current.onChange(imagesRef.current);
      URL.revokeObjectURL(item.url);
      update(pendingRef.current.filter((x) => x.key !== item.key));
    } catch (error) {
      if (generation.current !== epoch) return;
      update(
        pendingRef.current.map((x) =>
          x.key === item.key
            ? { ...x, uploading: false, error: errorMessage(error) }
            : x,
        ),
      );
    }
  }
  function addFiles(files: File[]) {
    if (disabledRef.current) return;
    for (const file of files) {
      if (allowFiles && /\.doc$/i.test(file.name)) {
        callbacks.current.onError("旧版Word .doc暂不支持，请在Word中另存为.docx后重新添加。");
        continue;
      }
      const origin = (file as File & { nativePath?: string }).nativePath || file.name;
      const key = `${origin}:${file.size}:${file.lastModified}`;
      if (fingerprints.current.has(key)) continue;
      const imageFile = isImageFile(file);
      const documentFile = allowFiles && isDocumentFile(file);
      if (!imageFile && !documentFile) {
        callbacks.current.onError(
          allowFiles
            ? "支持图片、DOCX、PDF、XLSX、TXT、MD、CSV、JSON"
            : "请添加 JPG、PNG 或 WebP 图片",
        );
        continue;
      }
      if (file.size > (documentFile ? maxDocumentBytes : maxImageBytes)) {
        callbacks.current.onError(
          allowFiles
            ? "办公文件最多 20 MB，图片最多 10 MB"
            : "图片不能超过 10 MB",
        );
        continue;
      }
      if (imagesRef.current.length + pendingRef.current.length >= 4) {
        callbacks.current.onError(
          allowFiles ? "每次最多提交 4 个附件" : "每次最多提交 4 张图片",
        );
        break;
      }
      fingerprints.current.set(key, key);
      const item = {
        key,
        file,
        url: URL.createObjectURL(file),
        error: "",
        uploading: true,
      };
      update([...pendingRef.current, item]);
      void upload(item);
    }
  }
  const addRef = useRef(addFiles);
  addRef.current = addFiles;
  const nativeTarget = useRef<HTMLElement | null>(null);
  nativeTarget.current = dropTarget?.current ?? null;
  useNativeDrop(dropTarget ?? nativeTarget, (files) => {
    for (const file of files) {
      if (!file.directory) { addRef.current([nativeFile(file)]); continue; }
      if (!allowFolders) { callbacks.current.onError("这里不支持文件夹，请添加文件"); continue; }
      if (imagesRef.current.some((item) => item.local_path === file.path)) continue;
      if (imagesRef.current.length + pendingRef.current.length >= 4) { callbacks.current.onError("每次最多提交 4 个附件"); break; }
      const folder: Attachment = { id: `folder:${crypto.randomUUID()}`, name: file.name, local_path: file.path,
        media_type: "inode/directory", width: 0, height: 0, size: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        file_status: "ready", error: "", warnings: [], parts: 0 };
      imagesRef.current = [...imagesRef.current, folder];
      callbacks.current.onChange(imagesRef.current);
    }
  }, onError, false, disabled, scopeKey, (value) => {
    nativeReading.current = value;
    callbacks.current.onUploading?.(value || pendingRef.current.some((item) => item.uploading || (allowFiles && Boolean(item.error))));
  });
  useEffect(() => {
    const target = dropTarget?.current;
    if (!target) return;
    let depth = 0;
    const fileDrag = (event: DragEvent) =>
      !isTauri() && Array.from(event.dataTransfer?.types || []).includes("Files");
    const enter = (event: DragEvent) => {
      if (fileDrag(event)) {
        event.preventDefault();
        depth++;
        if (!disabledRef.current) target.classList.add("image-drag-over");
      }
    };
    const leave = (event: DragEvent) => {
      if (fileDrag(event) && --depth <= 0) {
        depth = 0;
        target.classList.remove("image-drag-over");
      }
    };
    const over = (event: DragEvent) => {
      if (fileDrag(event)) {
        event.preventDefault();
        if (event.dataTransfer)
          event.dataTransfer.dropEffect = disabledRef.current ? "none" : "copy";
      }
    };
    const drop = (event: DragEvent) => {
      if (fileDrag(event)) {
        event.preventDefault();
        depth = 0;
        target.classList.remove("image-drag-over");
        const folders = Array.from(event.dataTransfer?.items || []).some((item) => item.webkitGetAsEntry?.()?.isDirectory);
        if (folders) callbacks.current.onError("文件夹只读引用请使用桌面端拖入");
        else addRef.current(Array.from(event.dataTransfer?.files || []));
      }
    };
    const paste = (event: ClipboardEvent) => {
      const files = clipboardImages(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      addRef.current(files);
    };
    target.addEventListener("dragenter", enter);
    target.addEventListener("dragleave", leave);
    target.addEventListener("dragover", over);
    target.addEventListener("drop", drop);
    target.addEventListener("paste", paste);
    return () => {
      target.classList.remove("image-drag-over");
      target.removeEventListener("dragenter", enter);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("dragover", over);
      target.removeEventListener("drop", drop);
      target.removeEventListener("paste", paste);
    };
  }, [dropTarget]);
  const previews =
    images.length > 0 || pending.length > 0 ? (
      <div
        className={`attachment-drafts ${previewMode === "names" ? "attachment-names" : ""}`}
        aria-label="待发送图片"
      >
        {images.map((image) => (
          <div
            className={`attachment-draft${image.local_path || image.file_status ? " is-file" : ""}`}
            key={image.id}
          >
            {image.local_path || image.file_status ? (
              // Files and folders use a compact row: icon, name and one status line.
              <>
                <div className="file-attachment-icon" aria-hidden="true">
                  {image.local_path ? <Folder size={18} /> : <FileText size={18} />}
                </div>
                <Hint label={image.local_path || image.name}>
                  <small className="file-attachment-name">{image.name}</small>
                </Hint>
                <small className="file-attachment-meta">
                  {image.local_path
                    ? "只读文件夹"
                    : image.file_status === "partial"
                      ? "部分解析"
                      : "可读取"}
                  {!!image.warnings?.length && " · 有解析提示"}
                </small>
              </>
            ) : (
              <>
                {previewMode === "thumbnails" && (
                  <Picture id={image.id} name={image.name} />
                )}
                <small>{image.name}</small>
              </>
            )}
            <button
              type="button"
              className="attachment-remove"
              aria-label={`移除 ${image.name}`}
              disabled={disabled}
              onClick={() => {
                fingerprints.current.forEach((value, key) => {
                  if (value === image.id) fingerprints.current.delete(key);
                });
                imagesRef.current = imagesRef.current.filter(
                  (x) => x.id !== image.id,
                );
                onChange(imagesRef.current);
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {pending.map((item) => (
          <div className="attachment-draft" key={item.key}>
            {allowFiles && isDocumentFile(item.file) ? (
              <FileText size={24} />
            ) : (
              previewMode === "thumbnails" && (
                <img src={item.url} alt={item.file.name} />
              )
            )}
            <small>{item.file.name}</small>
            {item.uploading ? (
              <span className="attachment-uploading">
                <Loader2 size={18} className="spin" />
                {allowFiles && <span>{item.phase || "上传中…"}</span>}
              </span>
            ) : (
              <button
                type="button"
                className="attachment-retry"
                aria-label={`重试上传 ${item.file.name}`}
                disabled={disabled}
                onClick={() => void upload(item)}
              >
                <RotateCw size={14} />
                重试
                {allowFiles && (
                  <span className="attachment-error-text">{item.error}</span>
                )}
              </button>
            )}
            <button
              type="button"
              className="attachment-remove"
              aria-label={`移除 ${item.file.name}`}
              disabled={disabled}
              onClick={() => {
                URL.revokeObjectURL(item.url);
                fingerprints.current.delete(item.key);
                update(pendingRef.current.filter((x) => x.key !== item.key));
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    ) : null;
  return (
    <div className="image-input">
      {!hideTrigger && (
        <Tooltip.Provider delayDuration={260} skipDelayDuration={100}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                className={`attach-button ${disabled ? "disabled" : ""}`}
                aria-label={allowFiles ? "添加文件或图片" : "添加图片"}
                disabled={disabled}
                onClick={() => fileInput.current?.click()}
              >
                <ImagePlus size={18} />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="ui-hint" side="top" sideOffset={7}>
                {allowFiles ? "添加文件或图片" : "添加图片"}
                <Tooltip.Arrow className="ui-hint-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
      )}
      <input
        ref={fileInput}
        type="file"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        accept={
          allowFiles
            ? "image/jpeg,image/png,image/webp,.docx,.pdf,.xlsx,.txt,.md,.csv,.json"
            : "image/jpeg,image/png,image/webp"
        }
        multiple
        disabled={disabled}
        onChange={(e) => {
          addFiles(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
      {portalTarget ? createPortal(previews, portalTarget) : previews}
    </div>
  );
}
