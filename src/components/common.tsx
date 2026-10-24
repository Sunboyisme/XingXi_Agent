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
import { AlertCircle, Check, TriangleAlert, X } from "lucide-react";
import { Tooltip } from "radix-ui";
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
import { api } from "@/lib/api";
import { ExternalLink } from "./ExternalLink";

export function Hint({
  label,
  side = "top",
  children,
}: {
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
  children: React.ReactElement;
}) {
  if (!label) return children;
  return (
    <Tooltip.Provider delayDuration={260} skipDelayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="ui-hint"
            side={side}
            sideOffset={7}
            collisionPadding={8}
          >
            {label}
            <Tooltip.Arrow className="ui-hint-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

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
}: {
  message: string;
  retry?: () => void;
  action?: { label: string; onClick: () => void };
  onClose?: () => void;
}) {
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={17} />
      <span className="error-notice-text">{message}</span>
      {(action || retry || onClose) && (
        <span className="error-notice-actions">
          {action && (
            <Button size="sm" variant="ghost" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
          {retry && (
            <Button size="sm" variant="ghost" onClick={retry}>
              重试
            </Button>
          )}
          {onClose && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="关闭错误提示"
              onClick={onClose}
            >
              <X size={15} aria-hidden="true" />
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

export function Toast({
  message,
  tone = "success",
  onClose,
}: {
  message: string;
  tone?: "success" | "error";
  onClose: () => void;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const timer = window.setTimeout(
      () => close.current(),
      tone === "error" ? 7000 : 4200,
    );
    return () => window.clearTimeout(timer);
  }, [message, tone]);
  return createPortal(
    <div className={`app-toast is-${tone}`} role="status" aria-live="polite">
      <span className="app-toast-icon" aria-hidden="true">
        {tone === "success" ? <Check size={15} /> : <AlertCircle size={15} />}
      </span>
      <span className="app-toast-text">{message}</span>
      <button
        type="button"
        className="app-toast-close"
        aria-label="关闭提示"
        onClick={onClose}
      >
        <X size={14} />
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
  cancelLabel = "保留",
  note,
  error,
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
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <AlertDialogContent className="confirm-dialog">
        <div className="confirm-dialog-heading">
          <span className="confirm-dialog-icon" aria-hidden="true">
            <TriangleAlert size={20} />
          </span>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
        </div>
        {note && <p className="confirm-dialog-note">{note}</p>}
        {error && <ErrorNotice message={error} />}
        <AlertDialogFooter className="confirm-dialog-footer">
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <Button
            variant="destructive"
            className="confirm-dialog-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
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

export async function remove(
  path: string,
  refresh: () => Promise<void> | void,
  onError: (message: string) => void,
) {
  try {
    await api(path, "DELETE");
    await refresh();
  } catch (error) {
    onError((error as Error).message);
  }
}
