import { useEffect, useLayoutEffect, useRef } from "react";
import { registerLearningFlush } from "@/lib/learningLifecycle";
import { ArrowUp, Loader2 } from "lucide-react";
import type { Attachment } from "@/lib/api";
import { resizeMessageInput } from "@/lib/composerSize";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { ImagesInput } from "./common";

export function LearningComposer({ answer, onAnswer, images = [], onImages, busy, uploading,
  onUploading, onError, onSubmit, scopeKey, placeholder = "写下你的理解，或继续提问…", label = "练习回答" }: {
  answer: string; onAnswer: (value: string) => void; images?: Attachment[];
  onImages?: (value: Attachment[]) => void; busy: boolean; uploading?: boolean;
  onUploading?: (value: boolean) => void; onError: (message: string) => void;
  onSubmit: () => void; scopeKey: string; placeholder?: string; label?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const drop = useRef<HTMLDivElement>(null);
  const previews = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = drop.current;
    const parent = element?.closest<HTMLElement>(".lesson-content, .learning-review-panel, .learning-intake-page");
    if (!element || !parent) return;
    const measure = () => parent.style.setProperty("--learning-composer-height", `${element.getBoundingClientRect().height}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [scopeKey]);
  const uploadState = useRef(uploading); uploadState.current = uploading;
  useEffect(() => {
    const unregister = registerLearningFlush(async () => {
      if (uploadState.current) throw new Error("图片仍在上传，请稍后再结束学习或关闭窗口。");
    });
    return () => { uploadState.current = false; unregister(); };
  }, []);
  useLayoutEffect(() => { if (input.current) resizeMessageInput(input.current); }, [answer, scopeKey]);
  return <section className="learning-composer-dock" aria-label="练习作答区" ref={drop}>
    <div className="learning-composer">
      <div className="learning-composer-attachments" ref={previews} />
      <Textarea ref={input} className="learning-message-input" aria-label={label} value={answer} rows={2} placeholder={placeholder}
        disabled={busy} onChange={(event) => onAnswer(event.target.value)} onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          if (!busy && !uploading && (answer.trim() || images.length)) onSubmit();
        }} />
      <div className="learning-composer-tools">
        {onImages && <ImagesInput key={scopeKey} scopeKey={scopeKey} dropTarget={drop}
          previewTarget={previews} previewMode="names" images={images} onChange={onImages}
          disabled={busy} onError={onError} onUploading={onUploading} />}
        <Button size="icon" aria-label={busy ? "正在分析中，请稍后…" : "发送回答"}
          disabled={busy || uploading || (!answer.trim() && !images.length)} onClick={onSubmit}>
          {busy ? <Loader2 size={17} className="spin" /> : <ArrowUp size={18} />}
        </Button>
      </div>
    </div>
  </section>;
}
