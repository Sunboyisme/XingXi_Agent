import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EmbeddingSettings } from "./EmbeddingSettings";
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const empty = {
  enabled: false,
  model: "",
  url: "https://example.com/v1",
  key_configured: false,
  indexed: 0,
  total: 0,
  error: "",
};

test("connection overview stays compact and real endpoint drafts save only on request", async () => {
  apiMock.mockResolvedValue(empty);
  const view = render(<EmbeddingSettings />);
  await screen.findByText("待配置");
  expect(screen.queryByLabelText("Embedding 接口地址")).toBeNull();
  expect(view.container.querySelector(".lucide-brain")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "配置语义记忆检索" }));
  expect(
    screen.getByText("按语义相似度召回相关记忆；关闭后仍可使用关键词检索。"),
  ).toBeTruthy();
  expect(screen.queryByText(/通常以 \/v1 结尾/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Embedding 接口地址"), {
    target: { value: "https://embedding.example/v1" },
  });
  fireEvent.change(screen.getByLabelText("Embedding 模型名称"), {
    target: { value: "my-embedding" },
  });
  fireEvent.change(screen.getByLabelText("Embedding API 密钥"), {
    target: { value: "synthetic-new-key" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  expect(
    apiMock.mock.calls.every(([path]) => path === "/settings/embedding"),
  ).toBe(true);
  apiMock.mockResolvedValue({
    ...empty,
    enabled: true,
    key_configured: true,
    model: "my-embedding",
  });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(apiMock).toHaveBeenCalledWith("/settings/embedding", "PUT", {
    enabled: true,
    url: "https://embedding.example/v1",
    model: "my-embedding",
    api_key: "synthetic-new-key",
  });
  expect(screen.queryByDisplayValue("synthetic-new-key")).toBeNull();
});
