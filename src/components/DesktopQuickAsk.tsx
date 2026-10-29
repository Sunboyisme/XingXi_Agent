import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUp,
  Plus,
  Mic,
  Square,
  X,
  Copy,
  ExternalLink,
  MessageSquarePlus,
  Camera,
  RotateCw,
} from "lucide-react";
import { BaiAvatar } from "./BaiAvatar";
import { Hint, Markdown } from "./common";
import { Picture } from "./ImageAttachments";
import {
  api,
  invoke,
  emitTo,
  desktopListen,
  desktopError,
  readQuickDraft,
  saveQuickDraft,
  models,
  selectedModel,
  addDesktopFile,
  imageFile,
  copyText,
  fetchApi,
  readEvents,
  type QuickDraft,
  type Settings,
  type Run,
} from "@/lib/desktopAssistant";

type VoiceState = {
  id: string;
  phase: string;
  seconds: number;
  level: number;
  error?: string;
};
export function DesktopQuickAsk() {
  const [draft, setDraft] = useState<QuickDraft>(readQuickDraft);
  const [settings, setSettings] = useState<Settings>();
  const [answer, setAnswer] = useState("");
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [voice, setVoice] = useState<VoiceState | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const current = useRef(draft);
  current.current = draft;
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const locked = useRef(false);
  const voiceId = useRef("");
  const voiceEpoch = useRef(0);
  const startingVoice = useRef(false);
  const pendingVoice = useRef<VoiceState | null>(null);
  const voiceRange = useRef({ start: 0, end: 0 });
  const startRequest = useRef(false);
  const held = useRef(false);
  const tracker = useRef<AbortController | null>(null);
  const lastImage = useRef("");
  const functions = useRef({
    send,
    startVoice,
    transcribe,
    receiveImage,
    pickFiles,
  });
  functions.current = { send, startVoice, transcribe, receiveImage, pickFiles };
  useEffect(() => {
    saveQuickDraft(draft);
  }, [draft]);
  useEffect(() => {
    const root = document.querySelector(".quick-window");
    if (!root) return;
    const update = () => {
      const tops = Array.from(root.children).map(
        (node) => node.getBoundingClientRect().top,
      );
      void invoke("desktop_quick_top", { top: Math.min(...tops) }).catch(
        () => {},
      );
    };
    const observer = new ResizeObserver(update);
    Array.from(root.children).forEach((node) => observer.observe(node));
    update();
    return () => observer.disconnect();
  }, [
    Boolean(answer || busy || error),
    draft.attachments.length,
    voice?.phase,
  ]);
  useEffect(() => {
    let alive = true;
    generation.current++;
    void api<Settings>("/settings")
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch((e) => {
        if (alive) setError(desktopError(e));
      });
    const listeners = [
      desktopListen<{ text: string }>("desktop-compose", (v) => {
        setDraft((d) => ({ ...d, text: v.text }));
        current.current = { ...current.current, text: v.text };
      }),
      desktopListen<string>("desktop-error", setError),
      desktopListen("desktop-submit", () => void functions.current.send()),
      desktopListen("desktop-record", () => {
        held.current = true;
        void functions.current.startVoice(true);
      }),
      desktopListen(
        "desktop-record-click",
        () => void functions.current.startVoice(),
      ),
      desktopListen("desktop-pick", () => void functions.current.pickFiles()),
      desktopListen("desktop-release", () => {
        held.current = false;
        if (voiceId.current) void invoke("voice_stop");
      }),
      desktopListen("desktop-voice-cancel", () => cancelVoice()),
      desktopListen<VoiceState>("desktop-voice", (v) => {
        if (voiceId.current !== v.id) {
          if (startingVoice.current) pendingVoice.current = v;
          return;
        }
        setVoice(v);
        if (v.phase === "ready") void functions.current.transcribe(v.id);
        if (v.phase === "error") {
          locked.current = false;
          setError(v.error || "录音失败");
        }
      }),
      desktopListen<{ id: string; dataUrl: string; action: string }>(
        "desktop-image",
        (v) => void functions.current.receiveImage(v),
      ),
    ];
    const saved = readQuickDraft();
    if (saved.conversationId) void restore(saved);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (voiceId.current || locked.current) cancelVoice();
        else void getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", onKey);
    const focus = getCurrentWindow().onFocusChanged((e) => {
      if (e.payload) {
        void api<Settings>("/settings")
          .then((s) => {
            if (alive) setSettings(s);
          })
          .catch(() => {});
        input.current?.focus();
      }
    });
    return () => {
      alive = false;
      generation.current++;
      tracker.current?.abort();
      request.current?.abort();
      listeners.forEach((p) => void p.then((f) => f()));
      void focus.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  async function restore(saved: QuickDraft) {
    const epoch = generation.current;
    try {
      const messages = await api<{ role: string; content: string }[]>(
        `/conversations/${saved.conversationId}/messages`,
      );
      if (epoch !== generation.current) return;
      setAnswer(
        messages.filter((m) => m.role === "assistant").at(-1)?.content || "",
      );
      setQuestion(
        messages.filter((m) => m.role === "user").at(-1)?.content || "",
      );
      if (saved.runId) {
        const run = await api<Run>(`/runs/${saved.runId}`);
        if (epoch !== generation.current) return;
        if (["pending", "running", "queued"].includes(run.status))
          await track(run.id, epoch);
      }
    } catch (e) {
      if (epoch === generation.current) {
        setError(desktopError(e));
      }
    }
  }
  async function track(runId: string, epoch: number) {
    tracker.current?.abort();
    const controller = new AbortController();
    tracker.current = controller;
    setBusy(true);
    setAnswer("");
    await emitTo("pet", "desktop-task", {
      title: "桌面问答",
      status: "正在思考…",
      conversationId: current.current.conversationId,
    }).catch(() => {});
    try {
      const result = await readEvents(
        runId,
        (event) => {
          if (epoch !== generation.current || controller.signal.aborted) return;
          if (event.kind === "delta")
            setAnswer((a) => a + String(event.data.text || ""));
          if (event.kind === "answer") setAnswer(String(event.data.text || ""));
          if (event.kind === "error")
            setError(String(event.data.message || "回答失败"));
        },
        controller.signal,
      );
      if (epoch === generation.current) {
        const text = (result.result as { text?: string })?.text;
        if (text) setAnswer(text);
        if (result.error) setError(result.error);
        await emitTo("pet", "desktop-task", {
          title: "桌面问答",
          status:
            result.status === "completed"
              ? "回答完成，点击查看"
              : result.status === "cancelled"
                ? "已停止"
                : "处理失败，点击查看",
          conversationId: current.current.conversationId,
        }).catch(() => {});
      }
    } catch (e) {
      if (!controller.signal.aborted && epoch === generation.current)
        setError(desktopError(e));
    } finally {
      if (epoch === generation.current) {
        setBusy(false);
        setDraft((d) => ({ ...d, runId: null }));
      }
    }
  }
  async function send() {
    const value = current.current;
    if (
      startRequest.current ||
      busy ||
      uploading ||
      locked.current ||
      (!value.text.trim() && !value.attachments.length)
    )
      return;
    startRequest.current = true;
    generation.current++;
    setError("");
    setBusy(true);
    const epoch = generation.current;
    try {
      let conversationId = value.conversationId;
      if (!conversationId)
        conversationId = (
          await api<{ id: string }>("/conversations", "POST", {
            title: "新对话",
          })
        ).id;
      const text = value.text.trim() || "请根据这张截图或附件帮助我分析。";
      const run = await api<Run>(
        `/conversations/${conversationId}/messages`,
        "POST",
        {
          content: text,
          attachment_ids: value.attachments.map((a) => a.id),
          model_selection: selectedModel(settings, value.modelKey),
        },
      );
      const next = {
        ...value,
        conversationId,
        text: "",
        attachments: [],
        runId: run.id,
      };
      current.current = next;
      setDraft(next);
      saveQuickDraft(next);
      setQuestion(text);
      await track(run.id, epoch);
    } catch (e) {
      setBusy(false);
      setError(desktopError(e));
    } finally {
      startRequest.current = false;
    }
  }
  async function stop() {
    if (current.current.runId) {
      try {
        await api(`/runs/${current.current.runId}/cancel`, "POST");
      } catch (e) {
        setError(desktopError(e));
      }
    }
  }
  async function pickFiles() {
    if (uploading || locked.current) return;
    setUploading(true);
    setError("");
    const epoch = generation.current;
    try {
      const files =
        await invoke<{ name: string; bytes: number[] }[]>("desktop_pick_files");
      if (files.length + current.current.attachments.length > 4)
        throw new Error("每次最多提交 4 个附件");
      for (const f of files) {
        const a = await addDesktopFile(
          new File([new Uint8Array(f.bytes)], f.name),
        );
        if (epoch !== generation.current) return;
        setDraft((d) => ({ ...d, attachments: [...d.attachments, a] }));
        current.current = {
          ...current.current,
          attachments: [...current.current.attachments, a],
        };
      }
    } catch (e) {
      setError(desktopError(e));
    } finally {
      setUploading(false);
    }
  }
  async function receiveImage(value: {
    id: string;
    dataUrl: string;
    action: string;
  }) {
    if (lastImage.current === value.id) return;
    lastImage.current = value.id;
    if (busy || uploading || locked.current) {
      setError("请先完成当前操作，再添加截图");
      return;
    }
    const epoch = generation.current;
    setUploading(true);
    setError("");
    try {
      const attachment = await addDesktopFile(await imageFile(value.dataUrl));
      if (epoch !== generation.current) return;
      if (value.action === "attach") {
        if (current.current.attachments.length >= 4)
          throw new Error("每次最多提交 4 个附件");
        setDraft((d) => ({
          ...d,
          attachments: [...d.attachments, attachment],
        }));
      } else {
        setDraft((d) => ({
          ...d,
          attachments: [...d.attachments.slice(0, 3), attachment],
        }));
        const run = await api<Run>("/desktop/actions", "POST", {
          action: value.action,
          attachment_id: attachment.id,
          model_selection: selectedModel(settings, current.current.modelKey),
        });
        setDraft((d) => ({ ...d, runId: run.id }));
        setQuestion(value.action === "ocr" ? "提取截图文字" : "翻译截图");
        await track(run.id, epoch);
      }
    } catch (e) {
      setError(desktopError(e));
    } finally {
      setUploading(false);
    }
  }
  async function startVoice(fromKey = false) {
    if (locked.current || uploading || busy) return;
    locked.current = true;
    setError("");
    const epoch = ++voiceEpoch.current;
    startingVoice.current = true;
    pendingVoice.current = null;
    setVoice({ id: "", phase: "starting", level: 0, seconds: 0 });
    voiceRange.current = {
      start: input.current?.selectionStart ?? current.current.text.length,
      end: input.current?.selectionEnd ?? current.current.text.length,
    };
    try {
      const id = await invoke<string>("voice_start");
      if (voiceEpoch.current !== epoch) {
        await invoke("voice_cancel", { id });
        return;
      }
      voiceId.current = id;
      startingVoice.current = false;
      const pending = pendingVoice.current as VoiceState | null;
      if (pending?.id === id) {
        setVoice(pending);
        if (pending.phase === "error") {
          locked.current = false;
          setError(pending.error || "录音失败");
        }
        if (pending.phase === "ready") void transcribe(id);
      } else setVoice({ id, phase: "recording", level: 0, seconds: 0 });
      if (fromKey && !held.current) await invoke("voice_stop");
    } catch (e) {
      startingVoice.current = false;
      setVoice(null);
      locked.current = false;
      setError(desktopError(e));
    }
  }
  async function transcribe(id: string) {
    if (voiceId.current !== id) return;
    locked.current = true;
    setVoice((v) => v && { ...v, phase: "transcribing" });
    const controller = new AbortController();
    request.current = controller;
    try {
      const bytes = await invoke<ArrayBuffer | number[]>("voice_audio_get", {
        id,
      });
      if (voiceId.current !== id) return;
      const form = new FormData();
      form.append(
        "file",
        new Blob(
          [bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)],
          { type: "audio/wav" },
        ),
        "recording.wav",
      );
      form.append("request_id", id);
      const result: { request_id: string; text: string } = await (
        await fetchApi("/speech/transcriptions", {
          method: "POST",
          body: form,
          signal: controller.signal,
        })
      ).json();
      if (voiceId.current !== id || result.request_id !== id) return;
      const range = voiceRange.current;
      setDraft((d) => ({
        ...d,
        text:
          d.text.slice(0, range.start) + result.text + d.text.slice(range.end),
      }));
      voiceId.current = "";
      setVoice(null);
      await invoke("voice_cancel");
      input.current?.focus();
    } catch (e) {
      if (!controller.signal.aborted && voiceId.current === id) {
        setVoice((v) => v && { ...v, phase: "error" });
        setError(desktopError(e));
      }
    } finally {
      if (voiceId.current === id || !voiceId.current) locked.current = false;
    }
  }
  function cancelVoice() {
    voiceEpoch.current++;
    startingVoice.current = false;
    pendingVoice.current = null;
    voiceId.current = "";
    held.current = false;
    request.current?.abort();
    locked.current = false;
    setVoice(null);
    void invoke("voice_cancel");
  }
  function newChat() {
    if (busy || locked.current || uploading) return;
    generation.current++;
    setDraft({
      text: "",
      attachments: [],
      conversationId: null,
      runId: null,
      modelKey: draft.modelKey,
    });
    setAnswer("");
    setQuestion("");
    setError("");
  }
  const voiceBusy =
    voice?.phase === "recording" ||
    voice?.phase === "transcribing" ||
    voice?.phase === "starting";
  return (
    <main className="quick-window">
      {(answer || busy || error) && (
        <section className="quick-answer">
          <header>
            <strong>{question || "XiaoXi"}</strong>
            <div>
              <Hint label="复制回答">
                <button
                  aria-label="复制回答"
                  disabled={!answer}
                  onClick={() =>
                    void copyText(answer).catch((e) =>
                      setError(desktopError(e)),
                    )
                  }
                >
                  <Copy size={15} />
                </button>
              </Hint>
              <Hint label="打开主窗口">
                <button
                  aria-label="打开主窗口"
                  onClick={() =>
                    void invoke("desktop_main", {
                      conversationId: draft.conversationId,
                    })
                  }
                >
                  <ExternalLink size={15} />
                </button>
              </Hint>
              <Hint label="收起问答">
                <button
                  aria-label="收起问答"
                  onClick={() => void getCurrentWindow().hide()}
                >
                  <X size={16} />
                </button>
              </Hint>
            </div>
          </header>
          <div className="quick-answer-scroll">
            <Markdown>{answer}</Markdown>
            {busy && <p role="status">正在处理…</p>}
            {error && (
              <p className="desktop-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </section>
      )}
      <div className="quick-composer-group">
        {draft.attachments.length > 0 && (
          <div className="quick-attachments">
            {draft.attachments.map((a) => (
              <div key={a.id}>
                {a.media_type?.startsWith("image/") ? (
                  <Picture id={a.id} name={a.name} />
                ) : (
                  <span>{a.name}</span>
                )}
                <Hint label="移除附件">
                  <button
                    aria-label="移除附件"
                    disabled={busy || uploading}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        attachments: d.attachments.filter((x) => x.id !== a.id),
                      }))
                    }
                  >
                    <X size={13} />
                  </button>
                </Hint>
              </div>
            ))}
          </div>
        )}
        <div className="quick-bar">
          <BaiAvatar interactive motion={busy ? "thinking" : "idle"} />
          <textarea
            ref={input}
            aria-label="随心输入"
            placeholder="随心输入"
            value={draft.text}
            disabled={Boolean(voiceBusy)}
            onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Hint label="添加桌面文件">
            <button
              aria-label="添加桌面文件"
              disabled={uploading || Boolean(voiceBusy)}
              onClick={() => void pickFiles()}
            >
              <Plus size={21} />
            </button>
          </Hint>
          <Hint
            label={
              <span>
                语音输入　按住 <kbd>右Alt</kbd>
              </span>
            }
          >
            <button
              aria-label="语音输入，按住右 Alt"
              className={voiceBusy ? "recording" : ""}
              disabled={voice?.phase === "transcribing"}
              onClick={() => {
                if (voice?.phase === "recording") void invoke("voice_stop");
                else {
                  held.current = false;
                  void startVoice();
                }
              }}
            >
              <Mic size={20} />
            </button>
          </Hint>
          <Hint label={busy ? "停止回答" : "发送"}>
            <button
              aria-label={busy ? "停止回答" : "发送"}
              disabled={
                !busy &&
                (uploading ||
                  Boolean(voiceBusy) ||
                  (!draft.text.trim() && !draft.attachments.length))
              }
              onClick={() => void (busy ? stop() : send())}
            >
              {busy ? <Square size={17} /> : <ArrowUp size={21} />}
            </button>
          </Hint>
        </div>
        <footer className="quick-footer">
          <select
            aria-label="问答模型"
            value={draft.modelKey}
            onChange={(e) =>
              setDraft((d) => ({ ...d, modelKey: e.target.value }))
            }
          >
            <option value="">当前默认模型</option>
            {models(settings).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
                {m.vision ? " · 图片" : ""}
              </option>
            ))}
          </select>
          <div>
            <Hint label="重新截图">
              <button
                aria-label="重新截图"
                disabled={busy || Boolean(voiceBusy)}
                onClick={() =>
                  void invoke("desktop_open", { capture: true }).catch((e) =>
                    setError(desktopError(e)),
                  )
                }
              >
                <Camera size={16} />
              </button>
            </Hint>
            <Hint label="新建悬浮对话">
              <button
                aria-label="新建悬浮对话"
                disabled={busy || uploading || Boolean(voiceBusy)}
                onClick={newChat}
              >
                <MessageSquarePlus size={16} />
              </button>
            </Hint>
            <Hint label="收起">
              <button
                aria-label="收起"
                onClick={() => {
                  cancelVoice();
                  void getCurrentWindow().hide();
                }}
              >
                <X size={16} />
              </button>
            </Hint>
          </div>
        </footer>
        {voice && (
          <div className="voice-status" role="status">
            <span
              className="voice-meter"
              style={{ width: `${Math.max(3, voice.level * 100)}%` }}
            />
            <span>
              {voice.phase === "recording"
                ? `正在录音 ${Math.floor(voice.seconds)} 秒`
                : voice.phase === "transcribing"
                  ? "正在识别…"
                  : "识别未完成"}
            </span>
            {voice.phase === "error" && (
              <button onClick={() => void transcribe(voice.id)}>
                <RotateCw size={14} />
                重试
              </button>
            )}
            <button onClick={cancelVoice}>取消</button>
          </div>
        )}
        {uploading && <p role="status">正在添加附件…</p>}
      </div>
    </main>
  );
}
