import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AnswerActions } from "./AnswerActions";
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

test("copy writes only this answer and reports success", async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  render(<AnswerActions content="这条回答的 **正文**" />);
  fireEvent.click(screen.getByRole("button", { name: "复制回答" }));
  await screen.findByRole("button", { name: "已复制回答" });
  expect(copy).toHaveBeenCalledWith("这条回答的 **正文**");
});

test("copy failures are visible rather than showing copied", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  render(<AnswerActions content="正文" />);
  fireEvent.click(screen.getByRole("button", { name: "复制回答" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "已复制回答" })).toBeNull();
});

test("old answer tools are loaded for its own run only after opening", async () => {
  apiMock.mockResolvedValue([
    {
      kind: "tool",
      data: { name: "计算器", result: { result: 703 }, status: "completed" },
    },
  ]);
  render(<AnswerActions content="703" runId="older-run" />);
  expect(apiMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "工具调用结果" }));
  await screen.findByText("结果：703");
  expect(apiMock).toHaveBeenCalledWith("/runs/older-run/tools");
  await waitFor(() =>
    expect(screen.getByRole("dialog").textContent).toContain("计算器"),
  );
});
