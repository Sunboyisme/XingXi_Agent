import { memo } from "react";
import { Markdown, Picture } from "./common";
import type { LearningTurn } from "@/lib/api";

function FeedbackReply({ value }: { value: Record<string, unknown> }) {
  const discussion = value.response_type === "discussion";
  return (
    <div
      className={`feedback-box ${discussion ? "discussion" : value.passed ? "passed" : "needs-practice"}`}
    >
      {!discussion && <h3>{value.passed ? "这次练习通过了" : "练习反馈"}</h3>}
      <Markdown>{String(value.explanation || "")}</Markdown>
      {!discussion && Array.isArray(value.gaps) && value.gaps.length > 0 && (
        <ul>
          {value.gaps.map((gap, index) => (
            <li key={index}>{String(gap)}</li>
          ))}
        </ul>
      )}
      {Boolean(value.next_step) && (
        <Markdown>{String(value.next_step)}</Markdown>
      )}
      {!discussion && Boolean(value.evidence) && (
        <p className="feedback-evidence">反馈依据：{String(value.evidence)}</p>
      )}
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
  return (
    <section className="learning-conversation" aria-label="本知识点的学习对话">
      {turns.map((turn) => (
        <div className="learning-exchange" key={turn.id}>
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
      ))}
      {!turns.length && fallback?.explanation ? (
        <FeedbackReply value={fallback} />
      ) : null}
    </section>
  );
});
