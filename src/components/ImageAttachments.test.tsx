import { useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ImagesInput, Picture } from "./ImageAttachments";
import type { Attachment } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  fetchApi: vi.fn(),
  uploadImage: vi.fn(),
  uploadFile: vi.fn(),
  api: vi.fn(),
}));
vi.mock("@/lib/api", () => mocks);
let counter = 0;
beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:test-${++counter}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  mocks.fetchApi.mockResolvedValue({ blob: async () => new Blob(["test"]) });
  mocks.uploadImage.mockImplementation(async (file: File) => ({
    id: file.name,
    name: file.name,
  }));
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function Host({ error = vi.fn(), uploading = vi.fn(), allowFiles = false }) {
  const target = useRef<HTMLDivElement>(null);
  const [images, setImages] = useState<Attachment[]>([]);
  return (
    <div ref={target} data-testid="drop">
      <ImagesInput
        allowFiles={allowFiles}
        images={images}
        onChange={setImages}
        dropTarget={target}
        onError={error}
        onUploading={uploading}
      />
    </div>
  );
}

test("drop uploads once, renders a thumbnail and supports zoom and removal", async () => {
  const uploading = vi.fn();
  render(<Host uploading={uploading} />);
  const file = new File(["image"], "preview.png", { type: "image/png" });
  const transfer = { types: ["Files"], files: [file] };
  fireEvent.drop(screen.getByTestId("drop"), { dataTransfer: transfer });
  await screen.findByRole("button", { name: "放大 preview.png" });
  fireEvent.drop(screen.getByTestId("drop"), { dataTransfer: transfer });
  expect(mocks.uploadImage).toHaveBeenCalledTimes(1);
  expect(uploading).toHaveBeenCalledWith(true);
  expect(uploading).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "放大 preview.png" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), {
    key: "Escape",
    code: "Escape",
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "移除 preview.png" }));
  expect(screen.queryByRole("button", { name: "放大 preview.png" })).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

test("pasted clipboard images enter the same attachment upload flow", async () => {
  render(<Host />);
  const file = new File(["image"], "粘贴截图.png", { type: "image/png" });
  fireEvent.paste(screen.getByTestId("drop"), {
    clipboardData: {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => file,
        },
      ],
      files: [file],
    },
  });
  await screen.findByRole("button", { name: "放大 粘贴截图.png" });
  expect(mocks.uploadImage).toHaveBeenCalledTimes(1);
  expect(mocks.uploadImage).toHaveBeenCalledWith(file);
});

test("failed upload can retry without losing other successful files", async () => {
  mocks.uploadImage
    .mockRejectedValueOnce(new Error("模拟上传失败"))
    .mockResolvedValueOnce({ id: "ok", name: "ok.png" })
    .mockResolvedValueOnce({ id: "retried", name: "failed.png" });
  render(<Host />);
  fireEvent.change(screen.getByLabelText("添加图片"), {
    target: {
      files: [new File(["x"], "failed.png"), new File(["x"], "ok.png")],
    },
  });
  const retry = await screen.findByRole("button", {
    name: "重试上传 failed.png",
  });
  await screen.findByRole("button", { name: "放大 ok.png" });
  fireEvent.click(retry);
  await screen.findByRole("button", { name: "放大 failed.png" });
  expect(screen.getByRole("button", { name: "放大 ok.png" })).toBeTruthy();
});

test("invalid types, oversized images and more than four files are blocked", async () => {
  const error = vi.fn();
  render(<Host error={error} />);
  const huge = new File(["x"], "huge.png");
  Object.defineProperty(huge, "size", { value: 10 * 1024 * 1024 + 1 });
  fireEvent.change(screen.getByLabelText("添加图片"), {
    target: {
      files: [
        new File(["x"], "bad.txt"),
        huge,
        ...Array.from({ length: 5 }, (_, i) => new File(["x"], `${i}.png`)),
      ],
    },
  });
  await waitFor(() => expect(mocks.uploadImage).toHaveBeenCalledTimes(4));
  expect(error).toHaveBeenCalledWith("请添加 JPG、PNG 或 WebP 图片");
  expect(error).toHaveBeenCalledWith("图片不能超过 10 MB");
  expect(error).toHaveBeenCalledWith("每次最多提交 4 张图片");
});

test("upload completing after conversation switch cannot attach to the new draft", async () => {
  let finish!: (value: unknown) => void;
  mocks.uploadImage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const change = vi.fn();
  const error = vi.fn();
  const view = render(
    <ImagesInput
      images={[]}
      onChange={change}
      onError={error}
      scopeKey="first"
    />,
  );
  fireEvent.change(screen.getByLabelText("添加图片"), {
    target: { files: [new File(["x"], "old.png")] },
  });
  view.rerender(
    <ImagesInput
      images={[]}
      onChange={change}
      onError={error}
      scopeKey="second"
    />,
  );
  finish({ id: "old", name: "old.png" });
  await waitFor(() => expect(screen.queryByAltText("old.png")).toBeNull());
  expect(change).not.toHaveBeenCalled();
});

test("image loading failure exposes retry instead of an endless loading label", async () => {
  mocks.fetchApi.mockRejectedValueOnce(new Error("missing"));
  render(<Picture id="test" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "图片加载失败，重试" }),
  );
  await screen.findByRole("button", { name: "放大 提交的图片" });
});

test("office documents show parsing state and become readable without image requests", async () => {
  mocks.uploadFile.mockResolvedValue({
    id: "office",
    name: "报告.docx",
    file_status: "queued",
    media_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  mocks.api.mockResolvedValue({
    id: "office",
    name: "报告.docx",
    file_status: "ready",
    warnings: [],
    media_type:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const uploading = vi.fn();
  render(<Host allowFiles uploading={uploading} />);
  fireEvent.change(screen.getByLabelText("添加文件或图片"), {
    target: { files: [new File(["docx"], "报告.docx")] },
  });
  expect(await screen.findByText("解析中…")).toBeTruthy();
  expect(await screen.findByText("可读取")).toBeTruthy();
  expect(mocks.uploadImage).not.toHaveBeenCalled();
  expect(mocks.fetchApi).not.toHaveBeenCalled();
  expect(uploading).toHaveBeenLastCalledWith(false);
});

test("failed office parsing keeps submission blocked until the failed attachment is removed", async () => {
  mocks.uploadFile.mockResolvedValue({
    id: "office",
    name: "扫描.pdf",
    file_status: "failed",
    error: "扫描文档需要 OCR",
  });
  const uploading = vi.fn();
  render(<Host allowFiles uploading={uploading} />);
  fireEvent.change(screen.getByLabelText("添加文件或图片"), {
    target: { files: [new File(["pdf"], "扫描.pdf")] },
  });
  await screen.findByText("扫描文档需要 OCR");
  expect(uploading).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "移除 扫描.pdf" }));
  expect(uploading).toHaveBeenLastCalledWith(false);
});
