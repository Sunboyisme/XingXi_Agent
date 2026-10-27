import { KnowledgeSources, type KnowledgeSource } from "./KnowledgeSources";
import { Button } from "./ui/button";
import { DetailDialog } from "./ui/detail-dialog";
import { memo, useState } from "react";
import { Markdown, Picture } from "./common";
import type { LearningTurn } from "@/lib/api";

function FeedbackReply({ value }: { value: Record<string, unknown> }) {
  const discussion = value.response_type === "discussion";
  return (
    <div className="learning-assistant-reply">
      {!discussion && value.passed === true && (
        <span className="learning-passed">这次练习通过了</span>
      )}
      <Markdown>{String(value.explanation || "")}</Markdown>
      <KnowledgeSources sources={value.knowledge_sources as KnowledgeSource[] | undefined} />
      {Boolean(value.reference_answer) && (
        <>
          <h4>参考答案</h4>
          <Markdown>{String(value.reference_answer)}</Markdown>
        </>
      )}
      {Boolean(value.next_exercise) ? (
        <>
          <h4>再试一题（可选）</h4>
          <Markdown numberedLists>{String(value.next_exercise)}</Markdown>
          {Boolean(value.next_requirements) && (
            <p className="muted">作答要求：{String(value.next_requirements)}</p>
          )}
        </>
      ) : (
        Boolean(value.next_step) && (
          <Markdown>{String(value.next_step).replaceAll("结束本节，下一节", "完成本章")}</Markdown>
        )
      )}
      {discussion && Boolean(value.active_exercise) && (
        <>
          <h4>当前练习</h4>
          <Markdown numberedLists>{String(value.active_exercise)}</Markdown>
          {Boolean(value.active_requirements) && <p className="muted">作答要求：{String(value.active_requirements)}</p>}
        </>
      )}
      {!discussion && Boolean(value.evidence) && (
        <DetailDialog
          title="反馈依据"
          label="反馈依据"
          className="learning-feedback-details"
        >
          <Markdown>{String(value.evidence)}</Markdown>
        </DetailDialog>
      )}
    </div>
  );
}

export function LearningPendingReply({
  answer,
  attachmentIds,
  fields,
  busy,
}: {
  answer?: string;
  attachmentIds: string[];
  fields: Record<string, string>;
  busy: boolean;
}) {
  return (
    <div className="learning-exchange learning-live-reply" aria-busy={busy}>
      {(answer || attachmentIds.length > 0) && (
        <div className="learning-user-reply">
          <span className="message-name">你</span>
          {answer && <Markdown>{answer}</Markdown>}
          {!!attachmentIds.length && (
            <div className="message-pictures">
              {attachmentIds.map((id) => (
                <Picture key={id} id={id} />
              ))}
            </div>
          )}
        </div>
      )}
      <span className="message-name">XiaoXi</span>
      {fields.explanation ? (
        <FeedbackReply value={fields} />
      ) : (
        <p className="learning-stream-status" role="status">
          {busy ? "正在分析中，请稍后…" : "本次回复未完成，草稿已保留。"}
        </p>
      )}
      {!busy && Boolean(fields.explanation) && (
        <p className="learning-stream-status">
          回复已中断，以上为收到的文字；正式记录暂未确认，草稿已保留。
        </p>
      )}
    </div>
  );
}

function LearningExchange({ turn }: { turn: Pick<LearningTurn, "id" | "answer" | "attachment_ids" | "feedback"> }) {
  return (
    <div className="learning-exchange">
      <div className="learning-user-reply">
        <span className="message-name">你</span>
        {turn.answer && <Markdown>{turn.answer}</Markdown>}
        {!!turn.attachment_ids.length && (
          <div className="message-pictures">
            {turn.attachment_ids.map((id) => (
              <Picture key={id} id={id} />
            ))}
          </div>
        )}
      </div>
      <span className="message-name">XiaoXi</span>
      <FeedbackReply value={turn.feedback} />
    </div>
  );
}

export const LearningConversation = memo(function LearningConversation({
  turns,
  fallback,
}: {
  turns: Pick<LearningTurn, "id" | "answer" | "attachment_ids" | "feedback">[];
  fallback?: Record<string, unknown>;
}) {
  const [visibleCount, setVisibleCount] = useState(6);
  return (
    <section className="learning-conversation" aria-label="本知识点的学习对话">
      {turns.length > visibleCount && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setVisibleCount((count) => count + 6)}
        >
          加载更早的对话 · 还有 {turns.length - visibleCount} 轮
        </Button>
      )}
      {turns.slice(-visibleCount).map((turn) => (
        <LearningExchange key={turn.id} turn={turn} />
      ))}
      {!turns.length && Boolean(fallback?.explanation) && fallback && (
        <div>
          <span className="message-name">XiaoXi</span>
          <FeedbackReply value={fallback} />
        </div>
      )}
    </section>
  );
});
