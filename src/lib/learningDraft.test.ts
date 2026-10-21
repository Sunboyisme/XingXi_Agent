import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Attachment, Lesson } from "./api";
import { useLearningDraft } from "./learningDraft";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("learning drafts survive node changes and remounts, and clear after review", () => {
  const first = {
    id: "lesson-1",
    node_id: "node-1",
    state: "awaiting_submission",
  } as Lesson;
  const second = {
    id: "lesson-2",
    node_id: "node-2",
    state: "awaiting_submission",
  } as Lesson;
  const hook = renderHook(
    ({ node, lesson }) => useLearningDraft(node, lesson),
    {
      initialProps: { node: first.node_id, lesson: first },
    },
  );
  act(() => {
    hook.result.current.setAnswer("尚未提交的思路");
    hook.result.current.setImages([
      { id: "picture", name: "草稿.png" } as Attachment,
    ]);
  });
  hook.rerender({ node: second.node_id, lesson: second });
  expect(hook.result.current.answer).toBe("");
  hook.rerender({ node: first.node_id, lesson: first });
  expect(hook.result.current.answer).toBe("尚未提交的思路");
  expect(hook.result.current.images[0].id).toBe("picture");
  hook.unmount();
  const reopened = renderHook(
    ({ lesson }) => useLearningDraft(first.node_id, lesson),
    { initialProps: { lesson: first } },
  );
  expect(reopened.result.current.answer).toBe("尚未提交的思路");
  reopened.rerender({ lesson: { ...first, state: "reviewed" } });
  expect(localStorage.getItem("bai-learning-draft:node-1")).toBeNull();
});
