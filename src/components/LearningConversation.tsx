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
      {Boolean(value.reference_answer) && (
        <>
          <h4>参考答案</h4>
          <Markdown>{String(value.reference_answer)}</Markdown>
        </>
      )}
      {Boolean(value.next_exercise) ? (
        <>
          <h4>换一道试试</h4>
          <Markdown numberedLists>{String(value.next_exercise)}</Markdown>
        </>
      ) : (
        Boolean(value.next_step) && (
          <Markdown>{String(value.next_step)}</Markdown>
        )
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

function LearningExchange({ turn }: { turn: LearningTurn }) {
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
  turns: LearningTurn[];
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
