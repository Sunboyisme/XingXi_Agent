import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnswerPresentation, RemotePicture } from "./AnswerPresentation";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  fetchApi: vi.fn(),
  isTauri: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@/lib/api", () => mocks);
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: mocks.isTauri,
  invoke: mocks.invoke,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("shows saved search sources even when the answer contains no links", async () => {
  mocks.api.mockResolvedValue({
    artifacts: [],
    sources: [
      {
        title: "真实网页",
        url: "https://example.com/article",
        summary: "工具返回的摘要",
        kind: "search",
      },
    ],
    errors: [],
  });
  render(
    <AnswerPresentation
      runId="run-1"
      status="completed"
      content="请看我的回答"
    />,
  );
  fireEvent.click(await screen.findByText("参考网页"));
  expect(await screen.findByRole("link", { name: /真实网页/ })).toHaveAttribute(
    "href",
    "https://example.com/article",
  );
  expect(screen.getByText(/搜索摘要/)).toBeTruthy();
  expect(mocks.api).toHaveBeenCalledWith("/runs/run-1/presentation");
});

test("failed Markdown image retries only fetching, without replaying generation", async () => {
  mocks.api.mockRejectedValue(new Error("图片地址已过期"));
  render(
    <RemotePicture
      runId="run-1"
      src="https://example.com/image.png"
      alt="图片"
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "图片加载失败，重试" }),
  );
  await screen.findByRole("button", { name: "图片加载失败，重试" });
  expect(mocks.api.mock.calls).toEqual(
    Array(2).fill([
      "/runs/run-1/images",
      "POST",
      { url: "https://example.com/image.png" },
    ]),
  );
});

test("native files export into the isolated data directory and open exports", async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.api
    .mockResolvedValueOnce({
      artifacts: [
        {
          id: "file-1",
          name: "笔记.md",
          image: false,
          media_type: "text/markdown",
          source_url: "",
        },
      ],
      sources: [],
      errors: [],
    })
    .mockResolvedValueOnce({ path: "preview/exports/笔记.md" });
  mocks.invoke.mockResolvedValue(undefined);
  render(
    <AnswerPresentation
      runId="run-1"
      status="completed"
      content="文件已保存"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "下载 笔记.md" }));
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("open_data_directory", {
      exports: true,
    }),
  );
  expect(mocks.api).toHaveBeenCalledWith("/artifacts/file-1/export", "POST");
  expect(mocks.fetchApi).not.toHaveBeenCalled();
});
