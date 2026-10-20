import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RetrievalDebugger } from "./RetrievalDebugger";
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const trace = {
  query: "如何回答",
  purpose: "preview",
  mode: "hybrid",
  fallback_reason: "",
  indexed: 1,
  total: 1,
  threshold: 0.35,
  token_budget: 1500,
  tokens_used: 50,
  duration_ms: 6,
  selected_ids: ["memory-1"],
  candidates: [
    {
      id: "memory-1",
      content: "偏好精炼答复",
      source: "评测样例",
      revision: 2,
      keyword_score: 0,
      semantic_score: 0.9,
      fusion_score: 0.0164,
      selected: true,
      reason: "已选中",
    },
  ],
};

test("manual preview only calls retrieval after submit and displays evidence", async () => {
  apiMock.mockResolvedValue(trace);
  render(<RetrievalDebugger />);
  expect(apiMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "试着查找记忆" }));
  expect(apiMock).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("检索测试问题"), {
    target: { value: "如何回答" },
  });
  fireEvent.click(screen.getByRole("button", { name: "查找" }));
  await screen.findByText("找到 1 条可以参考的记忆");
  fireEvent.click(screen.getByText("查看查找细节"));
  expect(apiMock).toHaveBeenCalledWith("/memories/retrieval/preview", "POST", {
    query: "如何回答",
  });
  expect(screen.getByText("90%")).toBeTruthy();
  expect(screen.getByText("来自：评测样例")).toBeTruthy();
});

test("answer evidence loads the saved run instead of rerunning current retrieval", async () => {
  apiMock.mockResolvedValue([
    { ...trace, purpose: "context", query: "原问题" },
  ]);
  render(<RetrievalDebugger runId="run-1" status="completed" />);
  fireEvent.click(screen.getByRole("button", { name: "参考的记忆" }));
  await screen.findByText("原问题");
  expect(apiMock).toHaveBeenCalledWith("/runs/run-1/retrieval");
  expect(apiMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("检索测试问题")).toBeNull();
});

test("missing old traces are explicit and errors do not show invented results", async () => {
  apiMock.mockResolvedValue([]);
  const view = render(<RetrievalDebugger runId="old" />);
  fireEvent.click(screen.getByRole("button", { name: "参考的记忆" }));
  await screen.findByText("这条旧回答没有留下记忆查找记录，也不会事后补造。");
  apiMock.mockRejectedValue(new Error("记录不可用"));
  view.rerender(<RetrievalDebugger runId="different" />);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("记录不可用"),
  );
});
