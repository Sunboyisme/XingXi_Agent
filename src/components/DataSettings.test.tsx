import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DataSettings } from "./DataSettings";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  fetchApi: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: mocks.api, fetchApi: mocks.fetchApi }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const data = {
  directory: "C:/isolated",
  database: "C:/isolated/bai.sqlite",
  attachments: "C:/isolated/attachments",
  storage: "SQLite",
  counts: { memories: 4, memory_vectors: 3 },
  pending: false,
};

test("shows the current storage and exports without touching provider settings", async () => {
  mocks.api.mockImplementation(async (path: string) =>
    path.endsWith("/export")
      ? { path: "C:/isolated/exports/data.zip", name: "data.zip" }
      : data,
  );
  mocks.invoke.mockResolvedValue("D:/chosen/data.zip");
  render(<DataSettings />);
  await screen.findByText("C:/isolated/bai.sqlite");
  fireEvent.click(screen.getByRole("button", { name: "导出数据" }));
  await screen.findByText("D:/chosen/data.zip");
  expect(mocks.invoke).toHaveBeenCalledWith("save_data_export");
  expect(mocks.api).not.toHaveBeenCalledWith("/settings/data/export", "POST");
  expect(mocks.api.mock.calls.some((call) => call[0] === "/settings")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "打开数据目录" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("open_data_directory"),
  );
});

test("cancelling export never reports a saved file, and save errors can be retried", async () => {
  mocks.api.mockResolvedValue(data);
  mocks.invoke
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("文件被占用"));
  render(<DataSettings />);
  await screen.findByText("C:/isolated/bai.sqlite");
  const button = screen.getByRole("button", { name: "导出数据" });
  fireEvent.click(button);
  await waitFor(() => expect(button).not.toBeDisabled());
  expect(screen.queryByText(/已导出到/)).toBeNull();
  fireEvent.click(button);
  await screen.findByText("文件被占用");
  expect(screen.queryByText(/已导出到/)).toBeNull();
  expect(button).not.toBeDisabled();
});

test("import inspection makes no changes until confirmation and can be cancelled after staging", async () => {
  let pending = false;
  mocks.api.mockImplementation(async (path: string, method?: string) => {
    if (path === "/settings/data/import") {
      pending = method === "POST";
      return { pending };
    }
    return { ...data, pending };
  });
  mocks.fetchApi.mockResolvedValue({
    json: async () => ({
      id: "a".repeat(32),
      counts: { memories: 7 },
      created_at: "2026-10-17T00:00:00Z",
    }),
  });
  render(<DataSettings />);
  await screen.findByText("C:/isolated/bai.sqlite");
  fireEvent.change(screen.getByLabelText("选择 XiaoXi 数据文件"), {
    target: { files: [new File(["zip"], "archive.zip")] },
  });
  await screen.findByRole("dialog", { name: "导入数据" });
  expect(mocks.api.mock.calls.some((call) => call[0].endsWith("/import"))).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "确认导入，重启后恢复" }));
  await screen.findByText(/数据已准备好/);
  expect(mocks.api).toHaveBeenCalledWith("/settings/data/import", "POST", {
    id: "a".repeat(32),
  });
  fireEvent.click(screen.getByRole("button", { name: "取消待导入" }));
  await waitFor(() =>
    expect(mocks.api).toHaveBeenCalledWith("/settings/data/import", "DELETE"),
  );
});
