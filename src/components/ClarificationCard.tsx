import { useEffect, useRef, useState } from "react";
import type { Clarification, ClarificationResponse } from "@/lib/api";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import "@/styles/clarification.css";

type Answer = ClarificationResponse["answers"][number];

export function ClarificationCard({
  request,
  disabled = false,
  onAnswer,
}: {
  request: Clarification;
  disabled?: boolean;
  onAnswer: (response: ClarificationResponse) => Promise<boolean>;
}) {
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    Object.fromEntries(
      (request.answers || []).map((answer) => [answer.question_id, answer]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const closed = request.state !== "pending" || sent;
  const locked = disabled || saving || closed;

  function change(questionId: string, optionId: string, multiple: boolean) {
    setAnswers((current) => {
      const previous = current[questionId] || {
        question_id: questionId,
        option_ids: [],
        custom_text: "",
      };
      const options = multiple
        ? previous.option_ids.includes(optionId)
          ? previous.option_ids.filter((value) => value !== optionId)
          : [...previous.option_ids, optionId]
        : [optionId];
      return { ...current, [questionId]: { ...previous, option_ids: options } };
    });
    setErrors((current) => ({ ...current, [questionId]: "" }));
    setError("");
  }

  async function submit() {
    if (locked || submitting.current) return;
    const missing: Record<string, string> = {};
    const values = request.questions.map((question) => {
      const answer = answers[question.id] || {
        question_id: question.id,
        option_ids: [],
        custom_text: "",
      };
      if (!answer.option_ids.length)
        missing[question.id] = "请选择一项或填写自己的回答。";
      else if (
        answer.option_ids.includes("other") &&
        !answer.custom_text.trim()
      )
        missing[question.id] = "请填写你的回答。";
      return {
        ...answer,
        custom_text: answer.option_ids.includes("other")
          ? answer.custom_text.trim()
          : "",
      };
    });
    setErrors(missing);
    if (Object.keys(missing).length) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const accepted = await onAnswer({
        request_id: request.request_id,
        source_message_id: request.source_message_id,
        answers: values,
      });
      if (mounted.current) {
        if (accepted) setSent(true);
        else setError("回答尚未提交，请查看提示后重试。选项和文字已保留。");
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "提交未完成，请重试。",
        );
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <form
      className="clarification-card"
      aria-label="补充信息"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="clarification-heading">
        <strong>需要你补充</strong>
        {closed && (
          <span role="status">
            {request.state === "superseded" ? "已继续对话" : "已回答"}
          </span>
        )}
      </div>
      {request.questions.map((question) => {
        const selected = answers[question.id]?.option_ids || [];
        const errorId = `clarification-error-${request.request_id}-${question.id}`;
        return (
          <fieldset
            key={question.id}
            disabled={locked}
            aria-describedby={errors[question.id] ? errorId : undefined}
          >
            <legend>
              {question.question}
              {question.multiple && <small>可多选</small>}
            </legend>
            <div className="clarification-options">
              {[
                ...question.options,
                { id: "other", label: "其他，我来填写", description: "" },
              ].map((option) => (
                <label
                  className="clarification-option"
                  data-selected={selected.includes(option.id)}
                  key={option.id}
                >
                  <input
                    type={question.multiple ? "checkbox" : "radio"}
                    name={`${request.request_id}-${question.id}`}
                    value={option.id}
                    checked={selected.includes(option.id)}
                    onChange={() =>
                      change(question.id, option.id, question.multiple)
                    }
                  />
                  <span>
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
            </div>
            {selected.includes("other") && (
              <Textarea
                className="clarification-custom"
                aria-label={`${question.question}：自己的回答`}
                aria-invalid={Boolean(errors[question.id])}
                aria-describedby={errors[question.id] ? errorId : undefined}
                placeholder="填写你的回答"
                maxLength={4000}
                rows={3}
                value={answers[question.id]?.custom_text || ""}
                onChange={(event) => {
                  const text = event.target.value;
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: {
                      ...current[question.id],
                      custom_text: text,
                    },
                  }));
                  setErrors((current) => ({ ...current, [question.id]: "" }));
                }}
              />
            )}
            {errors[question.id] && (
              <p className="clarification-error" id={errorId} role="alert">
                {errors[question.id]}
              </p>
            )}
          </fieldset>
        );
      })}
      {error && (
        <p className="clarification-error" role="alert">
          {error}
        </p>
      )}
      {!closed && (
        <Button type="submit" size="sm" disabled={locked}>
          {saving ? "正在提交…" : "提交并继续"}
        </Button>
      )}
    </form>
  );
}
