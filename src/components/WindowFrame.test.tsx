import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WindowFrame } from "./WindowFrame";

const windowMock = vi.hoisted(() => ({
  isMaximized: vi.fn(async () => false),
  minimize: vi.fn(async () => {}),
  toggleMaximize: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  onResized: vi.fn(async (_handler: () => void) => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMock,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("window controls remain available while the backend is loading", async () => {
  render(
    <WindowFrame collapsed={false}>
      <p>正在连接</p>
    </WindowFrame>,
  );
  expect(
    screen.getByRole("button", { name: "收起侧栏" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "最小化" }));
  fireEvent.click(screen.getByRole("button", { name: "最大化" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
  await waitFor(() => expect(windowMock.close).toHaveBeenCalledOnce());
  expect(windowMock.minimize).toHaveBeenCalledOnce();
  expect(windowMock.toggleMaximize).toHaveBeenCalledOnce();
});

test("maximize state follows native resize events and listener is released", async () => {
  const unlisten = vi.fn();
  let resized = () => {};
  windowMock.onResized.mockImplementationOnce(async (handler) => {
    resized = handler;
    return unlisten;
  });
  const view = render(
    <WindowFrame collapsed={true} onToggle={vi.fn()}>
      <p>内容</p>
    </WindowFrame>,
  );
  await waitFor(() => expect(windowMock.onResized).toHaveBeenCalledOnce());
  windowMock.isMaximized.mockResolvedValueOnce(true);
  resized();
  await screen.findByRole("button", { name: "还原窗口" });
  view.unmount();
  await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
});
