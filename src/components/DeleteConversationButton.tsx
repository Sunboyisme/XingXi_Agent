import { useState } from "react";
import { Popover } from "radix-ui";
import { Trash2 } from "lucide-react";
import type { Conversation } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";

export function DeleteConversationButton({
  conversation,
  disabled,
  onDelete,
}: {
  conversation: Conversation;
  disabled?: boolean;
  onDelete: (value: Conversation) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next);
          setError("");
        }
      }}
    >
      <Hint label="删除对话">
        <Popover.Trigger asChild>
          <button
            type="button"
            className="conversation-delete"
            aria-label={`删除对话 ${conversation.title}`}
            disabled={disabled || busy}
          >
            <Trash2 size={16} strokeWidth={1.5} />
          </button>
        </Popover.Trigger>
      </Hint>
      <Popover.Portal>
        <Popover.Content
          className="conversation-popconfirm"
          side="right"
          align="center"
          sideOffset={10}
          collisionPadding={12}
          aria-label="删除这段对话？"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <strong>删除这段对话？</strong>
          <p>
            聊天及专属附件、生成文件将被删除。已保存的记忆、课程和提醒会保留。
          </p>
          {error && (
            <p className="popconfirm-error" role="alert">
              {error}
            </p>
          )}
          <div>
            <Popover.Close asChild>
              <Button size="sm" variant="ghost" disabled={busy}>
                取消
              </Button>
            </Popover.Close>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await onDelete(conversation);
                    setOpen(false);
                  } catch (cause) {
                    setError(errorMessage(cause));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              {busy ? "正在删除…" : "删除对话"}
            </Button>
          </div>
          <Popover.Arrow className="conversation-popconfirm-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
