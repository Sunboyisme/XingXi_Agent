import { useEffect, useRef, useState } from "react";
import { Check, Copy, Pencil } from "lucide-react";
import { Button } from "./ui/button";
import { Hint } from "./common";

export function UserMessageActions({
  content,
  disabled,
  onEdit,
}: {
  content: string;
  disabled: boolean;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    setError("");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const previous = document.activeElement as HTMLElement | null;
        const input = document.createElement("textarea");
        input.value = content;
        input.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(input);
        input.select();
        let success = false;
        try {
          success = document.execCommand("copy");
        } finally {
          input.remove();
          previous?.focus();
        }
        if (!success) throw new Error("copy failed");
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("复制失败，请选择文字后复制。");
    }
  }

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
