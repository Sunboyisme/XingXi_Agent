import { api, fetchApi } from "./api";
import type { components } from "./api.generated";

export type TTSSettings = components["schemas"]["TTSSettingsRead"];
export type TTSProfile = components["schemas"]["TTSProfileWrite"];
export type SpeechPhase = "loading" | "playing";

/** Split on sentence/word boundaries without cutting a Unicode code point. */
export function splitSpeechText(text: string, limit = 280) {
  const chars = Array.from(text);
  const result: string[] = [];
  for (let offset = 0; offset < chars.length;) {
    let end = Math.min(chars.length, offset + limit);
    if (end < chars.length) {
      for (let at = end; at > offset + limit / 2; at--) {
        if (/[\s。！？；，.!?;,]/u.test(chars[at - 1])) {
          end = at;
          break;
        }
      }
    }
    const chunk = chars.slice(offset, end).join("");
    if (chunk.trim()) result.push(chunk);
    offset = end;
  }
  return result;
}

async function synthesize(
  text: string,
  profile: TTSProfile,
  signal: AbortSignal,
) {
  const request = new AbortController();
  const abort = () => request.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    request.abort();
  }, 90000);
  try {
    signal.throwIfAborted();
    const response = await fetchApi("/speech/synthesis", {
      method: "POST",
      body: JSON.stringify({ text, profile }),
      signal: request.signal,
    });
    const audio = await response.blob();
    signal.throwIfAborted();
    if (
      !audio.size ||
      audio.size > 16 * 1024 * 1024 ||
      !audio.type.startsWith("audio/")
    )
      throw new Error("朗读服务没有返回有效音频，请检查配置。");
    return audio;
  } catch (cause) {
    if (timedOut) throw new Error("语音合成超时，请稍后重试。");
    throw cause;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** One playing chunk plus at most one prefetched chunk; no files or persistent cache. */
export class OnlineSpeechPlayer {
  private controller: AbortController | null = null;
  stop() {
    const old = this.controller;
    this.controller = null;
    old?.abort(new DOMException("已停止朗读", "AbortError"));
  }
  async play(
    text: string,
    options: {
      profile?: TTSProfile;
      onPhase?: (phase: SpeechPhase) => void;
    } = {},
  ) {
    this.stop();
    if (!text.trim()) throw new Error("没有可以朗读的文字。");
    if (Array.from(text).length > 50000)
      throw new Error("朗读文字不能超过 50,000 字符，请分段朗读。");
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    try {
      options.onPhase?.("loading");
      let profile = options.profile;
      if (!profile) {
        const settings = await api<TTSSettings>(
          "/settings/tts",
          "GET",
          undefined,
          { signal, timeoutMs: 10000 },
        );
        const selected = settings.profiles.find(
          (value) => value.provider === settings.selected,
        );
        if (
          !selected?.url ||
          !selected.model ||
          !selected.voice ||
          (!selected.key_configured && selected.provider !== "custom")
        )
          throw new Error(
            "请在「连接与设置 → 能力连接 → 语音朗读」配置接口、模型、音色和密钥。",
          );
        profile = {
          provider: selected.provider,
          credential_connection_id: selected.credential_connection_id ?? null,
          url: selected.url,
          model: selected.model,
          voice: selected.voice,
        };
      }
      signal.throwIfAborted();
      const chunks = splitSpeechText(text);
      let pending = synthesize(chunks[0], profile, signal);
      for (let index = 0; index < chunks.length; index++) {
        const audio = await pending;
        signal.throwIfAborted();
        const next =
          index + 1 < chunks.length
            ? synthesize(chunks[index + 1], profile, signal)
            : null;
        void next?.catch(() => {});
        await this.playChunk(audio, signal, () => options.onPhase?.("playing"));
        if (next) {
          pending = next;
          options.onPhase?.("loading");
        }
      }
    } finally {
      controller.abort();
      if (this.controller === controller) this.controller = null;
    }
  }
  private playChunk(blob: Blob, signal: AbortSignal, onPlaying: () => void) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const audio = new Audio();
      const url = URL.createObjectURL(blob);
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () =>
        finish(signal.reason || new DOMException("已停止朗读", "AbortError"));
      signal.addEventListener("abort", aborted, { once: true });
      audio.onended = () => finish();
      audio.onerror = () =>
        finish(new Error("音频播放失败，请检查音频格式和输出设备后重试。"));
      audio.src = url;
      if (signal.aborted) {
        aborted();
        return;
      }
      void audio
        .play()
        .then(() => {
          if (!settled) onPlaying();
        })
        .catch(() =>
          finish(new Error("无法开始播放，请检查音频输出，或再次点击朗读。")),
        );
    });
  }
}
