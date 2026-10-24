import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LearningPage } from "./LearningPage";
import type { Goal, Lesson } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  uploadImage: vi.fn(),
  fetchApi: vi.fn(),
  readEvents: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  ...mocks,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});

test("the separate answer dock accepts dropped images and submits them without text", async () => {
  const node = {
    id: "n1",
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
    goal_id: "g1",
    objective: "理解方向",
    exercise_type: "drawing",
    review_at: null,
    title: "知识点",
    module: "模块",
    ordinal: 0,
    prerequisites: [],
    status: "learning",
  };
  const goal: Goal = {
    id: "g1",
    created_at: node.created_at,
    updated_at: node.updated_at,
    objective: "掌握知识点",
    foundation: "",
    status: "active",
    course_version: 1,
    title: "学习目标",
    current_node_id: node.id,
    nodes: [node, { ...node, id: "n2", ordinal: 1, title: "第二节" }],
  };
  const lesson: Lesson = {
    id: "l1",
    created_at: node.created_at,
    updated_at: node.updated_at,
    node_id: node.id,
    content: "教学内容",
    exercise: "画出你的理解",
    hints: [],
    feedback: {},
    state: "awaiting_submission",
  };
  localStorage.setItem("bai-current-goal", goal.id);
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/lesson")
      ? { ...lesson, id: path.includes("n2") ? "l2" : "l1" }
      : path.endsWith("/sessions")
        ? { id: "s1", goal_id: "g1", node_id: "n1", status: "active", draft_revision: 0, draft: { node_id: "n1", lesson_id: "l1", answer: "", attachment_ids: [] } }
      : path.endsWith("/submit")
        ? { id: "assessment", status: "queued" }
        : [],
  );
  mocks.readEvents.mockResolvedValue({ id: "assessment", status: "completed" });
  mocks.uploadImage.mockResolvedValue({ id: "image1", name: "answer.png" });
  mocks.fetchApi.mockResolvedValue({ blob: async () => new Blob(["image"]) });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:answer"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  render(
    <LearningPage
      goals={[goal]}
      refresh={vi.fn().mockResolvedValue(undefined)}
      onSettings={vi.fn()}
    />,
  );
  const dock = await screen.findByRole("region", { name: "练习作答区" });
  expect(dock.closest(".lesson-scroll")).toBeNull();
  expect(screen.getByRole("textbox", { name: "练习回答" })).toBeVisible();
  fireEvent.drop(dock, {
    dataTransfer: {
      types: ["Files"],
      files: [new File(["png"], "answer.png", { type: "image/png" })],
    },
  });
  await waitFor(() => expect(mocks.uploadImage).toHaveBeenCalledOnce());
  await screen.findByRole("button", { name: "移除 answer.png" });
  expect(dock.querySelector(".attachment-names small")?.textContent).toBe(
    "answer.png",
  );
  expect(dock.querySelector(".attachment-draft img")).toBeNull();
  expect(mocks.fetchApi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "发送回答" }));
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith(
      "/learning/lessons/l1/submit",
      "POST",
      expect.objectContaining({ answer: "", attachment_ids: ["image1"] }),
    ),
  );
  await screen.findByRole("button", { name: "发送回答" });
  expect(screen.queryByRole("button", { name: "下一个知识点" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "跳过，保留未验证状态" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /第二节/ }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "移除 answer.png" }),
    ).toBeNull(),
  );
});
