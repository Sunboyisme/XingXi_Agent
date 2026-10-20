import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExternalLink } from "./ExternalLink";
const native = vi.hoisted(() => ({ isTauri: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

test("desktop links go through the system browser command", async () => {
  native.isTauri.mockReturnValue(true);
  native.invoke.mockResolvedValue(undefined);
  render(
    <ExternalLink href="https://example.com/article?a=1&b=2">
      网页
    </ExternalLink>,
  );
  fireEvent.click(screen.getByRole("link"));
  await vi.waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("open_external_url", {
      url: "https://example.com/article?a=1&b=2",
    }),
  );
});

test("unsupported links cannot become desktop commands and errors stay visible", async () => {
  native.isTauri.mockReturnValue(true);
  const view = render(
    <ExternalLink href="file:///C:/private.txt">文件</ExternalLink>,
  );
  expect(screen.getByText("文件")).not.toHaveAttribute("href");
  fireEvent.click(screen.getByText("文件"));
  expect(native.invoke).not.toHaveBeenCalled();
  native.invoke.mockRejectedValue(new Error("failed"));
  view.rerender(<ExternalLink href="https://example.com">网页</ExternalLink>);
  fireEvent.click(screen.getByRole("link"));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法打开网页");
});
