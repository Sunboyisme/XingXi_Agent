import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AnswerPresentation, RemotePicture } from "./AnswerPresentation";
import { ArtifactPicture } from "./AnswerPresentation";
import { Markdown } from "./common";
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
    await screen.findByRole("button", { name: "图片地址已过期，点击重试" }),
  );
  await screen.findByRole("button", { name: "图片地址已过期，点击重试" });
  expect(mocks.api.mock.calls).toEqual(
    Array(2).fill([
      "/runs/run-1/images",
      "POST",
      { url: "https://example.com/image.png" },
    ]),
  );
});

test("native downloads go to the Windows Downloads folder", async () => {
  mocks.isTauri.mockReturnValue(true);
  mocks.api.mockResolvedValueOnce({
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
  });
  mocks.invoke.mockResolvedValue("C:/Users/me/Downloads/笔记.md");
  render(
    <AnswerPresentation
      runId="run-1"
      status="completed"
      content="文件已保存"
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "下载 笔记.md" }));
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("download_office_file", {
      fileId: "file-1",
      name: "笔记.md",
      upload: false,
    }),
  );
  expect(await screen.findByText("文件已下载")).toBeTruthy();
  expect(screen.getByText("C:/Users/me/Downloads/笔记.md")).toBeTruthy();
  expect(mocks.api).not.toHaveBeenCalledWith(
    "/artifacts/file-1/export",
    "POST",
  );
  expect(mocks.fetchApi).not.toHaveBeenCalled();
});

test("a decoded picture is reused when the same artifact remounts", async () => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:stable-picture"),
  });
  mocks.fetchApi.mockResolvedValue({
    blob: async () => new Blob(["image"], { type: "image/png" }),
  });
  const artifact = {
    id: "picture-cache",
    name: "poster.png",
    image: true,
    media_type: "image/png",
    source_url: "https://example.com/poster.png",
  };
  const first = render(<ArtifactPicture artifact={artifact} />);
  await screen.findByRole("img", { name: "poster.png" });
  first.unmount();
  render(<ArtifactPicture artifact={artifact} />);
  await screen.findByRole("img", { name: "poster.png" });
  expect(mocks.fetchApi).toHaveBeenCalledTimes(1);
});

test("streaming and scroll-driven rerenders keep the same loaded Markdown picture node", async () => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:markdown-stable"),
  });
  mocks.api.mockResolvedValue({
    id: "markdown-stable",
    name: "poster.png",
    image: true,
  });
  mocks.fetchApi.mockResolvedValue({ blob: async () => new Blob(["image"]) });
  const content = "方案一：\n\n![海报](https://example.com/stable.png)";
  const view = render(<Markdown runId="stable-run">{content}</Markdown>);
  const picture = await screen.findByRole("img", { name: "海报" });
  view.rerender(
    <Markdown runId="stable-run">{content + "\n\n继续写说明"}</Markdown>,
  );
  expect(screen.getByRole("img", { name: "海报" })).toBe(picture);
  view.rerender(
    <Markdown runId="stable-run">{content + "\n\n继续写说明"}</Markdown>,
  );
  expect(screen.getByRole("img", { name: "海报" })).toBe(picture);
  expect(screen.queryByText("图片加载中…")).toBeNull();
  expect(mocks.fetchApi).toHaveBeenCalledTimes(1);
});
