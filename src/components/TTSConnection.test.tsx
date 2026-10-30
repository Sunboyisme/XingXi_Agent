import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mock = vi.hoisted(() => ({ api: vi.fn(), play: vi.fn(), stop: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mock.api }));
vi.mock("@/lib/onlineSpeech", () => ({
  OnlineSpeechPlayer: class {
    play(text: string, options: unknown) {
      return mock.play(text, options);
    }
    stop() {
      mock.stop();
    }
  },
}));
import { TTSConnection } from "./TTSConnection";

const settings = {
  selected: "bailian",
  profiles: [
    {
      provider: "bailian",
      url: "https://example.com/v1",
      model: "qwen3-tts-flash",
      voice: "Cherry",
      key_configured: false,
    },
  ],
  presets: [
    {
      provider: "bailian",
      label: "阿里云百炼",
      url: "https://example.com/v1",
      model: "qwen3-tts-flash",
      voice: "Cherry",
      models: ["qwen3-tts-flash"],
      voices: [{ value: "Cherry", label: "Cherry" }],
      description: "在线语音",
      docs_url: "",
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.api.mockImplementation(async () => structuredClone(settings));
});
afterEach(cleanup);

test("failed saves retain the draft; successful saves clear the typed secret", async () => {
  let fail = true;
  mock.api.mockImplementation(async (_path, method) => {
    if (method === "PUT" && fail) throw new Error("暂时无法保存");
    return structuredClone(settings);
  });
  render(<TTSConnection />);
  fireEvent.click(await screen.findByRole("button", { name: "配置语音朗读" }));
  fireEvent.change(await screen.findByLabelText("API 密钥"), {
    target: { value: "synthetic-tts-key" },
  });
  fireEvent.change(screen.getByLabelText("语音模型"), {
    target: { value: "own-model" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText("暂时无法保存")).toBeVisible();
  expect(screen.getByLabelText("API 密钥")).toHaveValue("synthetic-tts-key");
  expect(screen.getByLabelText("语音模型")).toHaveValue("own-model");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByText("在线朗读配置已保存")).toBeVisible();
  expect(screen.getByLabelText("API 密钥")).toHaveValue("");
  expect(mock.api).toHaveBeenCalledWith(
    "/settings/tts",
    "PUT",
    expect.objectContaining({
      profiles: [
        expect.objectContaining({
          model: "own-model",
          api_key: "synthetic-tts-key",
        }),
      ],
    }),
  );
});

test("preview uses the draft and closing cancels it without saving", async () => {
  let finish!: () => void;
  mock.play.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<TTSConnection />);
  fireEvent.click(await screen.findByRole("button", { name: "配置语音朗读" }));
  fireEvent.change(await screen.findByLabelText("语音模型"), {
    target: { value: "preview-model" },
  });
  fireEvent.change(screen.getByLabelText("API 密钥"), {
    target: { value: "synthetic-preview-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "试听" }));
  await waitFor(() =>
    expect(mock.play).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        profile: expect.objectContaining({ model: "preview-model" }),
      }),
    ),
  );
  expect(screen.getByRole("button", { name: "停止试听" })).toBeVisible();
  const stopped = mock.stop.mock.calls.length;
  fireEvent.click(screen.getByText("关闭", { selector: "button" }));
  expect(mock.stop.mock.calls.length).toBeGreaterThan(stopped);
  await act(async () => finish());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mock.api.mock.calls.some((call) => call[1] === "PUT")).toBe(false);
});
