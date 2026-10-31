import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { Conversation } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { ConfirmDelete } from "./common";
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
    <>
      <Hint label="删除对话">
        <button
          type="button"
          className="conversation-delete"
          data-delete-action
          aria-label={`删除对话 ${conversation.title}`}
          disabled={disabled || busy}
          onClick={() => {
            setError("");
            setOpen(true);
          }}
        >
          <Trash2 size={16} strokeWidth={1.5} />
        </button>
      </Hint>
      <ConfirmDelete
        open={open}
        title="删除这段对话？"
        description="聊天及专属附件、生成文件将被删除。已保存的记忆、课程和提醒会保留。"
        label="删除对话"
        error={error}
        onClose={() => {
          setOpen(false);
          setError("");
        }}
        onConfirm={async () => {
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
        }}
      />
    </>
  );
}
