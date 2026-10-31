import { RemotePicture } from "./AnswerPresentation";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUpRight, Check, Info, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
export { ImagesInput, Picture } from "./ImageAttachments";
export { Hint } from "./ui/hint";
import { ExternalLink } from "./ExternalLink";
import { CodeBlock, TableBlock } from "./MarkdownBlocks";


export const Markdown = memo(function Markdown({
  children,
  runId,
  numberedLists = false,
}: {
  children: string;
  runId?: string;
  numberedLists?: boolean;
}) {
  // React treats these renderers as component types. Recreating them on each
  // token or scroll update remounts pictures and collapses their loaded height.
  const components = useMemo<Components>(
    () => ({
      pre: CodeBlock,
      table: TableBlock,
      img: ({ src, alt }) =>
        typeof src === "string" && runId ? (
          <RemotePicture runId={runId} src={src} alt={alt || "图片"} />
        ) : (
          <img src={src} alt={alt || "图片"} loading="lazy" />
        ),
      a: ({ node: _node, ...props }) => <ExternalLink {...props} />,
      ...(numberedLists
        ? {
            ul: ({
              children,
              className,
            }: {
              children?: ReactNode;
              className?: string;
            }) => <ol className={className}>{children}</ol>,
          }
        : {}),
    }),
    [runId, numberedLists],
  );
  return (
    <div className={`markdown${numberedLists ? " numbered-exercise" : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});

export function ErrorNotice({
  message,
  retry,
  action,
  onClose,
  tone = "error",
}: {
  message: string;
  retry?: () => void;
  action?: { label: string; onClick: () => void };
  onClose?: () => void;
  tone?: "info" | "success" | "warning" | "error";
}) {
  return (
    <div className={`error-notice app-feedback is-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {tone === "info" ? <Info size={17} aria-hidden="true" /> : tone === "success" ? <Check size={17} aria-hidden="true" /> : tone === "warning" ? <TriangleAlert size={17} aria-hidden="true" /> : null}
      <div className="error-notice-body">
        <span className="error-notice-text">{message}</span>
        {(action || retry) && (
          <span className="error-notice-actions">
            {action && (
              <Button type="button" size="sm" variant={tone === "error" ? "link" : "ghost"} onClick={action.onClick}>
                {action.label}
                {tone === "error" && <ArrowUpRight className="size-3.5" aria-hidden="true" />}
              </Button>
            )}
            {retry && (
              <Button type="button" size="sm" variant={tone === "error" ? "link" : "ghost"} onClick={retry}>
                重试
              </Button>
            )}
          </span>
        )}
      </div>
      {onClose && (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="error-notice-close"
          aria-label="关闭错误提示"
          onClick={onClose}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

export function Toast({
  message,
  tone = "success",
  action,
  onClose,
}: {
  message: string;
  tone?: "success" | "error";
  action?: React.ReactNode;
  onClose: () => void;
}) {
  const close = useRef(onClose);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  close.current = onClose;
  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(
      () => close.current(),
      tone === "error" ? 7000 : 4200,
    );
    return () => window.clearTimeout(timer);
  }, [message, tone, hovered, focused]);
  return createPortal(
    <div
      className={`app-toast is-${tone}`}
      role="status"
      aria-live="polite"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {tone === "success" && (
        <span className="app-toast-icon" aria-hidden="true">
          <Check size={15} />
        </span>
      )}
      <div className="app-toast-body">
        <span className="app-toast-text">{message}</span>
        {action && <span className="app-toast-actions">{action}</span>}
      </div>
      <button
        type="button"
        className="app-toast-close"
        aria-label="关闭提示"
        onClick={onClose}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: React.ComponentType<{ size: number }>;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={26} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function ConfirmDelete({
  open,
  title,
  description,
  label,
  cancelLabel = "取消",
  note,
  error,
  errorAction,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  label: string;
  cancelLabel?: string;
  note?: string;
  error?: string;
  errorAction?: { label: string; onClick: () => void };
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const deleteLock = useRef(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !deleteLock.current) onClose();
      }}
    >
      <AlertDialogContent className="confirm-dialog" aria-busy={busy}>
        <AlertDialogHeader className="confirm-dialog-heading">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {note && <p className="confirm-dialog-note">{note}</p>}
        {error && <ErrorNotice message={error} action={errorAction} />}
        <AlertDialogFooter className="confirm-dialog-footer">
          <AlertDialogCancel variant="ghost" disabled={busy}>
            {cancelLabel}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            className="confirm-dialog-danger"
            disabled={busy}
            onClick={async () => {
              if (deleteLock.current) return;
              deleteLock.current = true;
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                deleteLock.current = false;
                setBusy(false);
              }
            }}
          >
            {busy ? "正在删除…" : label}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export const nodeStatus: Record<string, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  needs_practice: "已学 · 待复习",
  passed: "练习通过",
  skipped: "已跳过 · 尚未验证",
};
