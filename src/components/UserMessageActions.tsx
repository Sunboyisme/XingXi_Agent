import { Check, Copy, Pencil } from "lucide-react";
import { Button } from "./ui/button";
import { Hint } from "./common";
import { useCopyFeedback } from "@/lib/clipboard";

export function UserMessageActions({
  content,
  disabled,
  onEdit,
}: {
  content: string;
  disabled: boolean;
  onEdit: () => void;
}) {
  const { copied, error, copy } = useCopyFeedback(content);

  return (
    <div
      className="answer-actions user-message-actions"
      role="group"
      aria-label="消息操作"
    >
      <Hint label={copied ? "已复制" : "复制消息"}>
        <Button
          className="answer-action"
          size="icon"
          variant="ghost"
          aria-label={copied ? "已复制消息" : "复制消息"}
          disabled={!content}
          onClick={() => void copy()}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </Button>
      </Hint>
      <Hint label="修改后重新发送">
        <Button
          className="answer-action"
          size="icon"
          variant="ghost"
          aria-label="修改消息"
          disabled={disabled}
          onClick={onEdit}
        >
          <Pencil size={15} />
        </Button>
      </Hint>
      {error && (
        <span className="copy-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
