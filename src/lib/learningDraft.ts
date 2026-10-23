import { useLayoutEffect, useRef, useState } from "react";
import type { Attachment, Lesson } from "./api";

export function clearLearningDraft(nodeId: string) {
  try {
    localStorage.removeItem(`bai-learning-draft:${nodeId}`);
  } catch {
    /* Draft storage is best effort. */
  }
}

export function useLearningDraft(nodeId: string, lesson: Lesson | null) {
  const [answer, setAnswerState] = useState("");
  const [images, setImagesState] = useState<Attachment[]>([]);
  const current = useRef({
    nodeId: "",
    lessonId: "",
    answer: "",
    images: [] as Attachment[],
  });
  const lessonId = lesson?.node_id === nodeId ? lesson.id : "";
  const awaiting = Boolean(
    lessonId &&
    ["awaiting_submission", "reviewed"].includes(lesson?.state || ""),
  );
  useLayoutEffect(() => {
    let answer = "",
      images: Attachment[] = [];
    if (awaiting) {
      try {
        const draft = JSON.parse(
          localStorage.getItem(`bai-learning-draft:${nodeId}`) || "null",
        );
        if (
          draft?.version === 1 &&
          draft.lessonId === lessonId &&
          typeof draft.answer === "string" &&
          Array.isArray(draft.images)
        ) {
          answer = draft.answer;
          images = draft.images.filter(
            (item: Attachment) =>
              item &&
              typeof item.id === "string" &&
              typeof item.name === "string",
          );
        }
      } catch {
        /* Ignore malformed or unavailable local storage. */
      }
    } else if (lessonId) {
      clearLearningDraft(nodeId);
    }
    current.current = {
      nodeId,
      lessonId: awaiting ? lessonId : "",
      answer,
      images,
    };
    setAnswerState(answer);
    setImagesState(images);
  }, [nodeId, lessonId, awaiting]);
  function persist() {
    const draft = current.current;
    if (!draft.lessonId) return;
    if (!draft.answer && !draft.images.length) {
      clearLearningDraft(draft.nodeId);
      return;
    }
    try {
      localStorage.setItem(
        `bai-learning-draft:${draft.nodeId}`,
        JSON.stringify({
          version: 1,
          lessonId: draft.lessonId,
          answer: draft.answer,
          images: draft.images,
        }),
      );
    } catch {
      /* Storage limits must not block an answer. */
    }
  }
  function setAnswer(value: string) {
    current.current.answer = value;
    setAnswerState(value);
    persist();
  }
  function setImages(value: Attachment[]) {
    current.current.images = value;
    setImagesState(value);
    persist();
  }
  return { answer, setAnswer, images, setImages };
}
