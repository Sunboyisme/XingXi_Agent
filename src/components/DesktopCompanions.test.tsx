import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({
  api: vi.fn(),
  invoke: vi.fn(),
  handlers: new Map<string, (value: any) => void>(),
}));
vi.mock("@/lib/desktopAssistant", async (original) => ({
  ...(await original<typeof import("@/lib/desktopAssistant")>()),
  api: mock.api,
  invoke: mock.invoke,
  desktopListen: (event: string, handler: (value: any) => void) => {
    mock.handlers.set(event, handler);
    return Promise.resolve(() => mock.handlers.delete(event));
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  PhysicalSize: class {},
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: 0, y: 0 }),
    scaleFactor: async () => 1,
    onMoved: async () => () => {},
    onFocusChanged: async () => () => {},
    isVisible: async () => false,
  }),
}));
vi.mock("@/lib/desktopHitRegions", () => ({ useDesktopHitRegions: () => {} }));
vi.mock("./BaiAvatar", () => ({ BaiAvatar: () => <span /> }));
import { DesktopPet } from "./DesktopCompanions";

beforeEach(() => {
  vi.clearAllMocks();
  mock.handlers.clear();
  localStorage.clear();
  mock.api.mockResolvedValue([]);
  mock.invoke.mockImplementation(async (command) =>
    command === "desktop_preferences"
      ? {
          preferences: { petSize: 100, petOffsetX: 200, petOffsetY: 250 },
          quickShown: false,
          quickEpoch: 1,
        }
      : undefined,
  );
});
afterEach(cleanup);

test("the task close button reads one task without collapsing the remaining inbox", async () => {
  render(<DesktopPet />);
  await waitFor(() => expect(mock.handlers.has("desktop-task")).toBe(true));
  for (const id of ["one", "two"])
    act(() =>
      mock.handlers.get("desktop-task")?.({
        runId: id,
        kind: "chat",
        runStatus: "completed",
        source: "main",
        title: `任务 ${id}`,
        status: "回答完成，点击查看",
        updatedAt: new Date(0).toISOString(),
      }),
    );
  fireEvent.click(screen.getByRole("button", { name: "标为已读 任务 one" }));
  expect(screen.queryByText("任务 one")).toBeNull();
  expect(screen.getByText("任务 two")).toBeVisible();
  expect(localStorage.getItem("xiaoxi-desktop-task-read:run:one")).toBeTruthy();
  expect(mock.invoke).not.toHaveBeenCalledWith(
    "desktop_main",
    expect.anything(),
  );
});

test("closing a reminder acknowledges it, keeps other cards open and ignores a stale poll", async () => {
  render(<DesktopPet />);
  await waitFor(() =>
    expect(mock.handlers.has("desktop-notification")).toBe(true),
  );
  const notes = [
    { id: "first", title: "提醒一", body: "内容一" },
    { id: "second", title: "提醒二", body: "内容二" },
  ];
  act(() => mock.handlers.get("desktop-notification")?.(notes));
  mock.api.mockRejectedValueOnce(new Error("暂时无法标记"));
  const close = screen.getByRole("button", { name: "标为已读 提醒一" });
  fireEvent.click(close);
  expect(await screen.findByText("暂时无法标记")).toBeVisible();
  expect(screen.getByText("提醒一")).toBeVisible();
  mock.api.mockResolvedValue([]);
  fireEvent.click(close);
  await waitFor(() => expect(screen.queryByText("提醒一")).toBeNull());
  expect(mock.api).toHaveBeenCalledWith(
    "/notifications/first/ack?read=true",
    "POST",
  );
  act(() => mock.handlers.get("desktop-notification")?.(notes));
  expect(screen.queryByText("提醒一")).toBeNull();
  expect(
    within(
      screen.getByRole("region", { name: "未读任务和提醒，共 1 条" }),
    ).getByText("提醒二"),
  ).toBeVisible();
  expect(mock.invoke).not.toHaveBeenCalledWith(
    "desktop_main",
    expect.anything(),
  );
});
