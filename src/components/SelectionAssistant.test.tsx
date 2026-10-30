import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mock = vi.hoisted(() => ({
  api: vi.fn(),
  invoke: vi.fn(),
  readEvents: vi.fn(),
  copyText: vi.fn(),
  handlers: new Map<string, (value: any) => void>(),
}));
vi.mock("@/lib/desktopAssistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/desktopAssistant")>()),
  api: mock.api,
  invoke: mock.invoke,
  readEvents: mock.readEvents,
  desktopListen: (event: string, handler: (value: any) => void) => {
    mock.handlers.set(event, handler);
    return Promise.resolve(() => mock.handlers.delete(event));
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
    isFocused: () => Promise.resolve(true),
  }),
}));
vi.mock("@/lib/desktopHitRegions", () => ({ useDesktopHitRegions: () => {} }));
vi.mock("./BaiAvatar", () => ({
  BaiAvatar: ({ motion }: { motion: string }) => (
    <span data-testid="selection-avatar" data-motion={motion} />
  ),
}));
vi.mock("@/lib/commonTexts", () => ({ notifyCommonTextsChanged: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyText: mock.copyText }));
import { SelectionAssistant } from "./SelectionAssistant";

beforeEach(() => {
  vi.clearAllMocks();
  mock.handlers.clear();
  mock.copyText.mockResolvedValue(undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mock.invoke.mockImplementation(async (command: string) =>
    command === "selection_snapshot"
      ? { id: 2, text: "春天到了，花开了。", error: "", x: 50, y: 50 }
      : undefined,
  );
  mock.api.mockImplementation(async (path: string) =>
    path === "/settings"
      ? {
          providers: [
            {
              id: "custom",
              label: "测试模型",
              models: [{ name: "model", vision_enabled: false }],
            },
          ],
          default_provider: "custom",
          model_name: "model",
        }
      : { id: "saved-text" },
  );
  mock.readEvents.mockResolvedValue({
    status: "completed",
    result: { text: "结果" },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("toolbar saves directly into the default category once, without a dialog", async () => {
  let complete!: (value: unknown) => void;
  mock.api.mockImplementation(async (path: string) =>
    path === "/common-texts"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : { providers: [], default_provider: "custom", model_name: "" },
  );
  render(<SelectionAssistant />);
  const add = await screen.findByRole("button", { name: "添加到常用文本" });
  fireEvent.click(add);
  fireEvent.click(add);
  expect(
    mock.api.mock.calls.filter((call) => call[0] === "/common-texts"),
  ).toEqual([
    [
      "/common-texts",
      "POST",
      { content: "春天到了，花开了。", category_id: null },
    ],
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => complete({ id: "saved-text" }));
  expect(await screen.findByText("已添加到默认分类")).toBeVisible();
  expect(add).toBeDisabled();
  expect(screen.getByTestId("selection-avatar")).toHaveAttribute(
    "data-motion",
    "still",
  );
  await waitFor(
    () =>
      expect(mock.invoke).toHaveBeenCalledWith("selection_dismiss", { id: 2 }),
    { timeout: 2000 },
  );
});

test("Escape closes a just-opened toolbar even when focus is on the window body", async () => {
  render(<SelectionAssistant />);
  await screen.findByRole("button", { name: "解释" });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(mock.invoke).toHaveBeenCalledWith("selection_dismiss", { id: 2 });
});

test("closing during run creation cancels the late run and never restores the result", async () => {
  let created!: (value: unknown) => void;
  const settings = {
    providers: [
      { id: "custom", label: "测试模型", models: [{ name: "model" }] },
    ],
    default_provider: "custom",
    model_name: "model",
  };
  mock.api.mockImplementation(async (path: string) =>
    path === "/settings"
      ? settings
      : path === "/desktop/actions"
        ? new Promise((resolve) => {
            created = resolve;
          })
        : {},
  );
  render(<SelectionAssistant />);
  fireEvent.click(await screen.findByRole("button", { name: "解释" }));
  await waitFor(() => expect(created).toBeDefined());
  act(() => mock.handlers.get("selection-hidden")?.(3));
  await act(async () => created({ id: "late-run" }));
  await waitFor(() =>
    expect(mock.api).toHaveBeenCalledWith("/runs/late-run/cancel", "POST"),
  );
  expect(screen.queryByRole("main")).toBeNull();
  expect(mock.readEvents).not.toHaveBeenCalled();
});

test("failed save retains the selection and offers a retry", async () => {
  mock.api.mockImplementation(async (path: string) => {
    if (path === "/common-texts") throw new Error("暂时无法保存");
    return { providers: [] };
  });
  render(<SelectionAssistant />);
  fireEvent.click(
    await screen.findByRole("button", { name: "添加到常用文本" }),
  );
  expect(await screen.findByText("暂时无法保存")).toBeVisible();
  expect(screen.getByRole("button", { name: "添加到常用文本" })).toBeEnabled();
});

test.each(["解释", "翻译", "总结"])(
  "%s disables thinking and renders only the answer",
  async (label) => {
    mock.readEvents.mockImplementation(async (_id, receive) => {
      receive({ kind: "reasoning", data: { text: "不应显示的内部推理" } });
      receive({ kind: "delta", data: { text: "直接处理结果" } });
      return { status: "completed", result: { text: "直接处理结果" } };
    });
    render(<SelectionAssistant />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(await screen.findByText("直接处理结果")).toBeVisible();
    const request = mock.api.mock.calls.find(
      (call) => call[0] === "/desktop/actions",
    )?.[2];
    expect(request.model_selection).toMatchObject({
      thinking_enabled: false,
      reasoning_effort: null,
    });
    expect(screen.queryByText("不应显示的内部推理")).toBeNull();
    expect(screen.queryByRole("button", { name: "问 AI" })).toBeNull();
  },
);

test("copy keeps its label and closes after feedback, while failures stay open", async () => {
  render(<SelectionAssistant />);
  const button = await screen.findByRole("button", { name: "复制" });
  mock.copyText.mockRejectedValueOnce(new Error("clipboard unavailable"));
  fireEvent.click(button);
  expect(
    await screen.findByText("复制失败，请重试或选择文字后复制。"),
  ).toBeVisible();
  expect(mock.invoke).not.toHaveBeenCalledWith(
    "selection_dismiss",
    expect.anything(),
  );
  fireEvent.click(button);
  expect(await screen.findByText("已复制选中文字")).toBeVisible();
  expect(button).toHaveTextContent("复制");
  expect(button).not.toHaveTextContent("已复制");
  expect(mock.copyText).toHaveBeenLastCalledWith("春天到了，花开了。");
  await waitFor(
    () =>
      expect(mock.invoke).toHaveBeenCalledWith("selection_dismiss", { id: 2 }),
    { timeout: 2000 },
  );
});

test("an earlier success timer cannot dismiss a fresh selection or a switched action", async () => {
  render(<SelectionAssistant />);
  fireEvent.click(await screen.findByRole("button", { name: "复制" }));
  await screen.findByText("已复制选中文字");
  act(() =>
    mock.handlers.get("selection-snapshot")?.({
      id: 4,
      text: "新的选区",
      error: "",
      x: 50,
      y: 50,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "添加到常用文本" }));
  await screen.findByText("已添加到默认分类");
  fireEvent.click(screen.getByRole("button", { name: "解释" }));
  await screen.findByText("结果");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1300)));
  expect(mock.invoke).not.toHaveBeenCalledWith(
    "selection_dismiss",
    expect.anything(),
  );
});
