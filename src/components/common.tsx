import { RemotePicture } from "./AnswerPresentation";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, TriangleAlert } from "lucide-react";
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

export function Markdown({
  children,
  runId,
}: {
  children: string;
  runId?: string;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) =>
            typeof src === "string" && runId ? (
              <RemotePicture runId={runId} src={src} alt={alt || "图片"} />
            ) : (
              <img src={src} alt={alt || "图片"} loading="lazy" />
            ),
          a: ({ node: _node, ...props }) => <ExternalLink {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function ErrorNotice({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={17} />
      <span>{message}</span>
      {retry && (
        <Button size="sm" variant="ghost" onClick={retry}>
          重试
        </Button>
      )}
    </div>
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
  needs_practice: "待巩固",
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
