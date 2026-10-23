import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WechatSection } from "./WechatSection";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
const disconnected = {
  enabled: false,
  bound: false,
  reminders_enabled: false,
  phase: "unbound",
  qr_image: "",
  error: "",
  deliveries: [],
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("only reads local status until the user connects", async () => {
  apiMock.mockResolvedValue(disconnected);
  render(<WechatSection />);
  await screen.findAllByText("未连接");
  expect(apiMock).toHaveBeenCalledTimes(1);
  expect(apiMock).toHaveBeenCalledWith("/wechat/status");
  expect(screen.queryByRole("img")).toBeNull();
});

test("connect requests a QR only after click and displays the scan action", async () => {
  apiMock.mockImplementation(async (path: string) =>
    path === "/wechat/connect"
      ? {
          ...disconnected,
          phase: "waiting",
          qr_image: "data:image/png;base64,dGVzdA==",
        }
      : disconnected,
  );
  render(<WechatSection />);
  await screen.findAllByText("未连接");
  fireEvent.click(screen.getByRole("button", { name: "连接微信" }));
  await screen.findByRole("img", { name: "使用本人微信扫码连接XiaoXi" });
  expect(apiMock).toHaveBeenCalledWith("/wechat/connect", "POST", undefined);
  expect(screen.getAllByText("等待扫码").length).toBeGreaterThan(0);
});

test("turning on reminders is explicit and delivery acceptance is qualified", async () => {
  const connected = {
    ...disconnected,
    enabled: true,
    bound: true,
    phase: "connected",
    deliveries: [
      {
        id: "delivery",
        status: "accepted",
        error: "",
        created_at: "2026-10-16",
      },
    ],
  };
  apiMock.mockImplementation(async (_path: string, method: string) =>
    method === "PUT" ? { ...connected, reminders_enabled: true } : connected,
  );
  render(<WechatSection />);
  await screen.findAllByText("已连接");
  const checkbox = screen.getByRole("checkbox");
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(checkbox);
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith("/wechat/options", "PUT", {
      enabled: true,
      reminders_enabled: true,
    }),
  );
  expect(screen.getByText("微信接口已接受")).toBeTruthy();
});
