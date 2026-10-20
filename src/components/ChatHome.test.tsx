import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ChatHome } from "./ChatHome";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

test("home shows actual pending items and resumes the selected conversation without creating data", async () => {
  apiMock.mockResolvedValue([
    {
      id: "p1",
      title: "已有的计划",
      status: "planned",
      start: "2026-10-19T01:00:00Z",
      all_day: false,
    },
    {
      id: "p2",
      title: "已经完成的事",
      status: "completed",
      start: "2026-10-19T02:00:00Z",
    },
  ]);
  const onConversation = vi.fn(),
    onAction = vi.fn(),
    onPlan = vi.fn(),
    onPrompt = vi.fn();
  render(
    <ChatHome
      goals={[]}
      conversations={[
        {
          id: "c1",
          title: "上次聊到一半的想法",
          created_at: "2026-10-18T01:00:00Z",
          updated_at: "2026-10-18T01:00:00Z",
        },
      ]}
      timezone="Asia/Shanghai"
      onConversation={onConversation}
      onAction={onAction}
      onPlan={onPlan}
      onPrompt={onPrompt}
    />,
  );
  expect(await screen.findByText("已有的计划")).toBeTruthy();
  expect(screen.queryByText("已经完成的事")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "添加安排" }));
  expect(onPrompt).toHaveBeenCalledOnce();
  expect(onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /打开计划 已有的计划/ }));
  expect(onPlan).toHaveBeenCalledWith(
    expect.objectContaining({ id: "p1", title: "已有的计划" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /上次聊到一半的想法/ }));
  expect(onConversation).toHaveBeenCalledWith("c1");
  expect(apiMock.mock.calls.every((call) => call.length === 1)).toBe(true);
});

test("failed plan reads do not claim an empty schedule; the plan page stays accessible", async () => {
  apiMock.mockRejectedValue(new Error("offline"));
  const onAction = vi.fn();
  render(
    <ChatHome
      goals={[]}
      conversations={[]}
      timezone="Asia/Shanghai"
      onConversation={vi.fn()}
      onAction={onAction}
      onPlan={vi.fn()}
      onPrompt={vi.fn()}
    />,
  );
  expect(await screen.findByText("暂时没有读到计划")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "全部计划" }));
  expect(onAction).toHaveBeenCalledWith("plans");
});

test("home offers natural prompt ideas for planning, notes and exploring", async () => {
  apiMock.mockResolvedValue([]);
  const onPrompt = vi.fn();
  render(
    <ChatHome
      goals={[]}
      conversations={[]}
      timezone="Asia/Shanghai"
      onConversation={vi.fn()}
      onAction={vi.fn()}
      onPlan={vi.fn()}
      onPrompt={onPrompt}
    />,
  );
  expect(screen.queryByText("可以这样问")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "整理笔记" }));
  expect(onPrompt).toHaveBeenCalledWith(
    "请把下面这段文字整理成清晰的笔记：\n\n",
  );
  fireEvent.click(screen.getByRole("button", { name: "解释概念" }));
  expect(onPrompt).toHaveBeenLastCalledWith(
    "请用一个生活里的例子，把这个概念讲清楚：\n\n",
  );
});
