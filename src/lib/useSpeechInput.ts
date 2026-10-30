import { useEffect, useRef, useState, type RefObject } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fetchApi } from "./api";
import { desktopError as message } from "./desktopAssistant";

type SpeechState = {
  id: string;
  phase: string;
  seconds: number;
  level: number;
  error?: string;
};
type Options = {
  scopeKey: string;
  input: RefObject<HTMLTextAreaElement | null>;
  readText: () => string;
  writeText: (text: string) => void;
  onError: (message: string) => void;
  isBlocked?: () => boolean;
  isVisible?: () => boolean;
  onLockChange?: (locked: boolean) => void;
  onBegin?: () => void;
};

/** One recording belongs to one editor scope; late events may never replace another draft. */
export function useSpeechInput(options: Options) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const [voice, setVoice] = useState<SpeechState | null>(null);
  const current = useRef<SpeechState | null>(null);
  const mounted = useRef(false);
  const id = useRef("");
  const epoch = useRef(0);
  const starting = useRef(false);
  const early = useRef<SpeechState | null>(null);
  const held = useRef<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const range = useRef({ text: "", start: 0, end: 0, scope: options.scopeKey });
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  const functions = useRef({ accept, cancel });
  functions.current = { accept, cancel };
  const previousScope = useRef(options.scopeKey);
  function publish(value: SpeechState | null) {
    current.current = value;
    callbacks.current.onLockChange?.(Boolean(value && value.phase !== "error"));
    if (mounted.current) setVoice(value);
  }
  const isLocked = () =>
    Boolean(current.current && current.current.phase !== "error");
  function cancel(notify = true) {
    const recording = id.current;
    epoch.current++;
    id.current = "";
    held.current = null;
    starting.current = false;
    early.current = null;
    request.current?.abort();
    request.current = null;
    publish(null);
    if (notify && recording)
      void invoke("voice_cancel", { id: recording }).catch(() => {});
  }
  useEffect(() => {
    mounted.current = true;
    if (!isTauri())
      return () => {
        mounted.current = false;
      };
    const listener = listen<SpeechState>("desktop-voice", (e) =>
      functions.current.accept(e.payload),
    );
    const closeListener = getCurrentWindow().onCloseRequested(() =>
      functions.current.cancel(),
    );
    ready.current = listener;
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        current.current &&
        !document.querySelector(
          '[role="dialog"],[role="listbox"],[role="menu"]',
        )
      ) {
        e.preventDefault();
        functions.current.cancel();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      mounted.current = false;
      functions.current.cancel();
      void listener.then((unlisten) => unlisten());
      void closeListener.then((unlisten) => unlisten()).catch(() => {});
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    if (previousScope.current !== options.scopeKey) {
      previousScope.current = options.scopeKey;
      if (current.current && range.current.scope !== options.scopeKey)
        functions.current.cancel();
    }
  }, [options.scopeKey]);
  function accept(value: SpeechState) {
    if (!mounted.current) return;
    if (value.id !== id.current) {
      if (starting.current) early.current = value;
      return;
    }
    if (value.phase === "cancelled") {
      cancel(false);
      return;
    }
    if (value.phase === "error") {
      cancel();
      callbacks.current.onError(value.error || "录音失败");
      return;
    }
    publish(value);
    if (value.phase === "ready") void transcribe(value.id);
  }
  async function start(gesture?: number) {
    if (isLocked() || callbacks.current.isBlocked?.()) return;
    cancel();
    if (!isTauri()) {
      callbacks.current.onError("语音输入仅在桌面版中可用");
      return;
    }
    const sequence = ++epoch.current;
    const c = callbacks.current;
    const text = c.readText();
    range.current = {
      text,
      start: c.input.current?.selectionStart ?? text.length,
      end: c.input.current?.selectionEnd ?? text.length,
      scope: c.scopeKey,
    };
    held.current = gesture ?? null;
    starting.current = true;
    c.onError("");
    c.onBegin?.();
    publish({ id: "", phase: "starting", seconds: 0, level: 0 });
    try {
      await ready.current;
      if (!mounted.current || sequence !== epoch.current) return;
      const recording = await invoke<string>("voice_start", { gesture });
      if (
        !mounted.current ||
        sequence !== epoch.current ||
        callbacks.current.scopeKey !== range.current.scope
      ) {
        await invoke("voice_cancel", { id: recording });
        return;
      }
      id.current = recording;
      starting.current = false;
      const pending = early.current as SpeechState | null;
      if (pending?.id === recording) accept(pending);
      else publish({ id: recording, phase: "recording", seconds: 0, level: 0 });
      if (gesture !== undefined && held.current !== gesture)
        await invoke("voice_stop", { id: recording });
    } catch (e) {
      if (sequence !== epoch.current || !mounted.current) return;
      starting.current = false;
      publish(null);
      if (!message(e).includes("手势已结束"))
        callbacks.current.onError(message(e));
    }
  }
  async function transcribe(recording: string) {
    if (id.current !== recording || request.current) return;
    const sequence = epoch.current;
    const c = callbacks.current;
    if (c.readText() !== range.current.text) {
      const text = c.readText();
      range.current = {
        ...range.current,
        text,
        start: c.input.current?.selectionStart ?? text.length,
        end: c.input.current?.selectionEnd ?? text.length,
      };
    }
    const insertion = range.current;
    c.onError("");
    publish({ ...current.current!, phase: "transcribing" });
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 80000);
    try {
      const bytes = await invoke<ArrayBuffer | number[]>("voice_audio_get", {
        id: recording,
      });
      if (sequence !== epoch.current || id.current !== recording) return;
      const form = new FormData();
      form.append(
        "file",
        new Blob(
          [bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)],
          { type: "audio/wav" },
        ),
        "recording.wav",
      );
      form.append("request_id", recording);
      const result: { request_id: string; text: string } = await (
        await fetchApi("/speech/transcriptions", {
          method: "POST",
          body: form,
          signal: controller.signal,
        })
      ).json();
      if (
        !mounted.current ||
        sequence !== epoch.current ||
        id.current !== recording ||
        callbacks.current.scopeKey !== insertion.scope
      )
        return;
      if (
        !result ||
        result.request_id !== recording ||
        typeof result.text !== "string"
      )
        throw new Error("语音识别返回无效，请重新录音");
      if (!result.text.trim()) throw new Error("没有识别到文字，请重新录音");
      if (callbacks.current.readText() !== insertion.text)
        throw new Error("输入内容已变化，请重新录音");
      const text =
        insertion.text.slice(0, insertion.start) +
        result.text +
        insertion.text.slice(insertion.end);
      callbacks.current.writeText(text);
      id.current = "";
      publish(null);
      void invoke("voice_cancel", { id: recording }).catch(() => {});
      requestAnimationFrame(() => {
        const latest = callbacks.current;
        if (
          !mounted.current ||
          sequence !== epoch.current ||
          latest.scopeKey !== insertion.scope ||
          latest.readText() !== text ||
          latest.isVisible?.() === false
        )
          return;
        latest.input.current?.focus({ preventScroll: true });
        latest.input.current?.setSelectionRange(
          insertion.start + result.text.length,
          insertion.start + result.text.length,
        );
      });
    } catch (e) {
      if (
        mounted.current &&
        sequence === epoch.current &&
        id.current === recording
      ) {
        const error = controller.signal.aborted
          ? "识别超时，请重新录音。"
          : message(e);
        cancel();
        callbacks.current.onError(error);
      }
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) request.current = null;
    }
  }
  async function stop() {
    const recording = id.current;
    const sequence = epoch.current;
    if (!recording) return;
    try {
      await invoke("voice_stop", { id: recording });
    } catch (e) {
      if (
        !mounted.current ||
        sequence !== epoch.current ||
        id.current !== recording
      )
        return;
      cancel();
      callbacks.current.onError(message(e));
    }
  }
  function release(gesture: number) {
    if (held.current === gesture) {
      held.current = null;
      void stop();
    }
  }
  function toggle() {
    if (current.current?.phase === "recording") void stop();
    else if (
      current.current?.phase === "transcribing" ||
      current.current?.phase === "starting"
    )
      cancel();
    else void start();
  }
  return {
    voice,
    busy: Boolean(voice && voice.phase !== "error"),
    isLocked,
    start,
    stop,
    cancel,
    release,
    toggle,
  };
}
export type SpeechInputController = ReturnType<typeof useSpeechInput>;
