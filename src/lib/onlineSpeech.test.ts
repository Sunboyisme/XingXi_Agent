import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { waitFor } from "@testing-library/react";
const mock = vi.hoisted(() => ({
  api: vi.fn(),
  fetchApi: vi.fn(),
  createURL: vi.fn(),
  revokeURL: vi.fn(),
}));
vi.mock("./api", () => ({ api: mock.api, fetchApi: mock.fetchApi }));
import { OnlineSpeechPlayer, splitSpeechText } from "./onlineSpeech";

const audios: FakeAudio[] = [];
class FakeAudio {
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => {});
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  constructor() {
    audios.push(this);
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  audios.length = 0;
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = mock.createURL;
      static revokeObjectURL = mock.revokeURL;
    },
  );
  mock.createURL.mockImplementation(
    () => `blob:test-${mock.createURL.mock.calls.length}`,
  );
  vi.stubGlobal("Audio", FakeAudio);
  mock.api.mockResolvedValue({
    selected: "bailian",
    profiles: [
      {
        provider: "bailian",
        url: "https://example.com",
        model: "model",
        voice: "voice",
        key_configured: true,
      },
    ],
  });
  mock.fetchApi.mockResolvedValue({
    blob: async () => new Blob(["ID3-fake-audio-data"], { type: "audio/mpeg" }),
  });
});
afterEach(() => vi.unstubAllGlobals());

test("splitting preserves text and Unicode within the service character limit", () => {
  const text =
    "这是第一段。".repeat(60) + "🙂".repeat(400) + " A short English sentence.";
  const chunks = splitSpeechText(text);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every((chunk) => Array.from(chunk).length <= 280)).toBe(true);
});
test("only one following chunk is prefetched and stopping releases playback URLs", async () => {
  const player = new OnlineSpeechPlayer();
  const result = player.play("文".repeat(850)).catch((cause) => cause);
  await waitFor(() => expect(audios).toHaveLength(1));
  expect(mock.fetchApi).toHaveBeenCalledTimes(2);
  audios[0].onended?.();
  await waitFor(() => expect(audios).toHaveLength(2));
  expect(mock.fetchApi).toHaveBeenCalledTimes(3);
  player.stop();
  expect((await result).name).toBe("AbortError");
  expect(mock.createURL).toHaveBeenCalledTimes(2);
  expect(mock.revokeURL).toHaveBeenCalledTimes(2);
  expect(audios[1].pause).toHaveBeenCalled();
});
test("a new reading cancels the old reading without losing the new player", async () => {
  const player = new OnlineSpeechPlayer();
  const old = player.play("原文").catch((cause) => cause);
  await waitFor(() => expect(audios).toHaveLength(1));
  const next = player.play("译文").catch((cause) => cause);
  await waitFor(() => expect(audios).toHaveLength(2));
  expect((await old).name).toBe("AbortError");
  player.stop();
  expect((await next).name).toBe("AbortError");
  expect(mock.revokeURL).toHaveBeenCalledTimes(2);
});
test("missing credentials give configuration guidance without submitting text", async () => {
  mock.api.mockResolvedValue({
    selected: "bailian",
    profiles: [
      {
        provider: "bailian",
        url: "https://example.com",
        model: "model",
        voice: "voice",
        key_configured: false,
      },
    ],
  });
  await expect(new OnlineSpeechPlayer().play("私人选区")).rejects.toThrow(
    "语音朗读",
  );
  expect(mock.fetchApi).not.toHaveBeenCalled();
});
test("preview uses the unsaved profile and never saves it", async () => {
  const player = new OnlineSpeechPlayer();
  const result = player.play("试听", {
    profile: {
      provider: "custom",
      url: "https://example.com/v1",
      model: "tts",
      voice: "voice",
      api_key: "synthetic-key",
    },
  });
  await waitFor(() => expect(audios).toHaveLength(1));
  audios[0].onended?.();
  await result;
  expect(mock.api).not.toHaveBeenCalled();
  expect(JSON.parse(mock.fetchApi.mock.calls[0][1].body).profile.api_key).toBe(
    "synthetic-key",
  );
  expect(mock.revokeURL).toHaveBeenCalledTimes(1);
});
