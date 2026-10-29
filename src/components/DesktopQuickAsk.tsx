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
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
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
  type Attachment,
} from "@/lib/desktopAssistant";
type VoiceState = {
  id: string;
  phase: string;
  seconds: number;
  level: number;
  error?: string;
  retryable?: boolean;
};
type IncomingImage = {
  id: string;
  dataUrl: string;
  action: string;
  attachment?: Attachment;
  failed?: boolean;
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
  const [pendingCount, setPendingCount] = useState(0);
  const [hiddenEpoch, setHiddenEpoch] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const current = useRef(draft);
  const mounted = useRef(false);
  const visible = useRef(false);
  const generation = useRef(0);
  const viewReady = useRef(false);
  const tracking = useRef(0);
  const work = useRef({ busy: false, uploading: false, locked: false });
  const startRequest = useRef(false);
  const tracker = useRef<AbortController | null>(null);
  const request = useRef<AbortController | null>(null);
  const voiceId = useRef("");
  const voiceEpoch = useRef(0);
  const startingVoice = useRef(false);
  const pendingVoice = useRef<VoiceState | null>(null);
  const heldGesture = useRef<number | null>(null);
  const voiceRange = useRef({ start: 0, end: 0, text: "" });
  const composingSequence = useRef(0);
  const pending = useRef<IncomingImage[]>([]);
  const seen = useRef(new Set<string>());
  const imageWorking = useRef(false);
  const functions = useRef({
    send,
    startVoice,
    transcribe,
    receiveImage,
    pickFiles,
    shown,
    drainImages,
  });
  functions.current = {
    send,
    startVoice,
    transcribe,
    receiveImage,
    pickFiles,
    shown,
    drainImages,
  };
  useDesktopHitRegions(
    ".quick-answer,.quick-composer-group,.ui-hint,[role=dialog],[role=listbox],[role=menu],[data-slot=dialog-overlay]",
  );
  function updateDraft(change: QuickDraft | ((d: QuickDraft) => QuickDraft)) {
    const next =
      typeof change === "function" ? change(current.current) : change;
    current.current = next;
    saveQuickDraft(next);
    if (mounted.current) setDraft(next);
  }
  function setRunBusy(value: boolean) {
    work.current.busy = value;
    if (mounted.current) setBusy(value);
  }
  function setFileBusy(value: boolean) {
    work.current.uploading = value;
    if (mounted.current) setUploading(value);
  }
  useEffect(() => {
    void invoke("desktop_quick_state", {
      text: draft.text,
      busy: busy || uploading || Boolean(voice && voice.phase !== "error"),
    }).catch(() => {});
  }, [draft.text, busy, uploading, voice?.phase]);
  useEffect(() => {
    if (!busy && !uploading && !voice) void functions.current.drainImages();
  }, [busy, uploading, voice, pendingCount]);
  useEffect(() => {
    mounted.current = true;
    const epoch = ++generation.current;
    const listeners = [
      desktopListen<{ text: string; sequence: number }>(
        "desktop-compose",
        (v) => {
          if (v.sequence <= composingSequence.current) return;
          composingSequence.current = v.sequence;
          updateDraft((d) => ({ ...d, text: v.text }));
        },
      ),
      desktopListen<string>("desktop-error", (v) => {
        if (mounted.current) setError(v);
      }),
      desktopListen("desktop-submit", () => void functions.current.send()),
      desktopListen("desktop-pick", () => void functions.current.pickFiles()),
      desktopListen<{ gesture: number }>("desktop-record", (v) => {
        heldGesture.current = v.gesture;
        void functions.current.startVoice(v.gesture);
      }),
      desktopListen(
        "desktop-record-click",
        () => void functions.current.startVoice(),
      ),
      desktopListen<{ gesture: number }>("desktop-release", (v) => {
        if (heldGesture.current === v.gesture) {
          heldGesture.current = null;
          if (voiceId.current)
            void invoke("voice_stop", { id: voiceId.current });
        }
      }),
      desktopListen("desktop-voice-cancel", () => cancelVoice()),
      desktopListen("desktop-hidden", () => {
        visible.current = false;
        cancelVoice();
        setHiddenEpoch((value) => value + 1);
        setError("");
      }),
      desktopListen("desktop-shown", () => void functions.current.shown()),
      desktopListen<VoiceState>("desktop-voice", (v) => {
        if (voiceId.current !== v.id) {
          if (startingVoice.current) pendingVoice.current = v;
          return;
        }
        acceptVoice(v);
      }),
      desktopListen<IncomingImage>("desktop-image", (v) =>
        functions.current.receiveImage(v),
      ),
    ];
    void Promise.all(listeners)
      .then(async () => {
        if (!mounted.current || epoch !== generation.current) return;
        await refreshSettings(false);
        if (current.current.conversationId) await restore();
        if (await getCurrentWindow().isVisible())
          await functions.current.shown();
      })
      .catch(() => {});
    const key = (e: KeyboardEvent) => {
      if (
        e.key !== "Escape" ||
        e.defaultPrevented ||
        document.querySelector('[role="dialog"],[role="listbox"],[role="menu"]')
      )
        return;
      e.preventDefault();
      if (work.current.locked || voiceId.current) cancelVoice();
      else void dismiss();
    };
    window.addEventListener("keydown", key);
    return () => {
      mounted.current = false;
      visible.current = false;
      generation.current++;
      tracking.current++;
      tracker.current?.abort();
      request.current?.abort();
      voiceEpoch.current++;
      void invoke("voice_cancel", { id: voiceId.current || undefined });
      listeners.forEach((p) => void p.then((f) => f()));
      window.removeEventListener("keydown", key);
    };
  }, []);
  async function refreshSettings(report: boolean) {
    try {
      const s = await api<Settings>("/settings");
      if (mounted.current) setSettings(s);
    } catch (e) {
      if (report && mounted.current) setError(desktopError(e));
    }
  }
  async function shown() {
    visible.current = true;
    if (
      mounted.current &&
      !work.current.locked &&
      !work.current.uploading &&
      !document.querySelector('[role="dialog"]')
    )
      input.current?.focus({ preventScroll: true });
    await refreshSettings(false);
    if (!mounted.current || !visible.current) return;
    if (
      !work.current.busy &&
      !viewReady.current &&
      (current.current.conversationId || current.current.runId)
    )
      void restore();
    if (
      mounted.current &&
      !work.current.locked &&
      !document.querySelector('[role="dialog"]')
    )
      input.current?.focus({ preventScroll: true });
  }
  async function dismiss() {
    cancelVoice();
    visible.current = false;
    setError("");
    await invoke("desktop_dismiss");
  }
  async function restore() {
    if (work.current.busy || startRequest.current || viewReady.current) return;
    const epoch = generation.current;
    const id = current.current.conversationId;
    if (!id) {
      if (current.current.runId) {
        viewReady.current = true;
        void track(current.current.runId, epoch);
      }
      return;
    }
    try {
      const messages = await api<{ role: string; content: string }[]>(
        `/conversations/${id}/messages`,
      );
      if (
        !mounted.current ||
        epoch !== generation.current ||
        id !== current.current.conversationId ||
        work.current.busy
      )
        return;
      setAnswer(
        messages.filter((m) => m.role === "assistant").at(-1)?.content || "",
      );
      setQuestion(
        messages.filter((m) => m.role === "user").at(-1)?.content || "",
      );
      viewReady.current = true;
      if (current.current.runId) {
        const run = await api<Run>(`/runs/${current.current.runId}`);
        if (
          !mounted.current ||
          epoch !== generation.current ||
          work.current.busy
        )
          return;
        if (["pending", "running", "queued"].includes(run.status))
          void track(run.id, epoch);
        else updateDraft((d) => ({ ...d, runId: null }));
      }
    } catch (e) {
      if (visible.current && mounted.current && epoch === generation.current)
        setError(desktopError(e));
    }
  }
  async function track(id: string, epoch: number) {
    viewReady.current = true;
    const sequence = ++tracking.current;
    tracker.current?.abort();
    const controller = new AbortController();
    tracker.current = controller;
    setRunBusy(true);
    setAnswer("");
    void emitTo("pet", "desktop-task", {
      title: "桌面问答",
      status: "正在思考…",
      conversationId: current.current.conversationId,
      runId: id,
    });
    try {
      const result = await readEvents(
        id,
        (e) => {
          if (
            !mounted.current ||
            epoch !== generation.current ||
            sequence !== tracking.current ||
            controller.signal.aborted
          )
            return;
          if (e.kind === "delta")
            setAnswer((a) => a + String(e.data.text || ""));
          if (e.kind === "answer") setAnswer(String(e.data.text || ""));
          if (e.kind === "error")
            setError(String(e.data.message || "回答失败"));
        },
        controller.signal,
      );
      if (
        mounted.current &&
        epoch === generation.current &&
        sequence === tracking.current
      ) {
        const text = (result.result as { text?: string })?.text;
        if (text) setAnswer(text);
        if (result.error) setError(result.error);
        void emitTo("pet", "desktop-task", {
          title: "桌面问答",
          status:
            result.status === "completed"
              ? "回答完成，点击查看"
              : result.status === "cancelled"
                ? "已停止"
                : "处理失败，点击查看",
          conversationId: current.current.conversationId,
          runId: id,
        });
      }
    } catch (e) {
      if (
        !controller.signal.aborted &&
        mounted.current &&
        epoch === generation.current &&
        sequence === tracking.current
      )
        setError(desktopError(e));
    } finally {
      if (
        mounted.current &&
        epoch === generation.current &&
        sequence === tracking.current
      ) {
        setRunBusy(false);
        updateDraft((d) => ({ ...d, runId: null }));
      }
    }
  }
  async function send() {
    const value = current.current;
    if (
      startRequest.current ||
      work.current.busy ||
      work.current.uploading ||
      work.current.locked ||
      (!value.text.trim() && !value.attachments.length)
    )
      return;
    startRequest.current = true;
    const epoch = ++generation.current;
    setError("");
    setRunBusy(true);
    try {
      const selected = selectedModel(settings, value.modelKey);
      const choices = models(settings);
      const choice =
        choices.find((m) => m.key === value.modelKey) ||
        choices.find(
          (m) =>
            m.selection.provider_id === settings?.default_provider &&
            m.selection.model_name === settings?.model_name,
        );
      if (
        value.attachments.some((a) => a.media_type.startsWith("image/")) &&
        choice &&
        !choice.vision
      )
        throw new Error(
          "当前模型不支持图片，请在下方选择支持图片的模型。截图和文字已保留。",
        );
      let id = value.conversationId;
      if (!id) {
        id = (
          await api<{ id: string }>("/conversations", "POST", {
            title: "新对话",
          })
        ).id;
        updateDraft((d) => ({ ...d, conversationId: id }));
      }
      const text = value.text.trim() || "请根据这张截图或附件帮助我分析。";
      const run = await api<Run>(`/conversations/${id}/messages`, "POST", {
        content: text,
        attachment_ids: value.attachments.map((a) => a.id),
        model_selection: selected,
      });
      updateDraft({
        ...value,
        conversationId: id,
        text: "",
        attachments: [],
        runId: run.id,
      });
      if (!mounted.current || epoch !== generation.current) return;
      setQuestion(text);
      await track(run.id, epoch);
    } catch (e) {
      if (mounted.current && epoch === generation.current) {
        setRunBusy(false);
        setError(desktopError(e));
      }
    } finally {
      startRequest.current = false;
    }
  }
  async function stop() {
    const id = current.current.runId;
    if (id)
      try {
        await api(`/runs/${id}/cancel`, "POST");
      } catch (e) {
        setError(desktopError(e));
      }
  }
  async function pickFiles() {
    if (work.current.uploading || work.current.locked || work.current.busy)
      return;
    setFileBusy(true);
    setError("");
    const epoch = generation.current;
    try {
      const files =
        await invoke<{ name: string; bytes: number[] }[]>("desktop_pick_files");
      if (files.length + current.current.attachments.length > 4)
        throw new Error("每次最多提交 4 个附件");
      for (const file of files) {
        const attachment = await addDesktopFile(
          new File([new Uint8Array(file.bytes)], file.name),
        );
        if (!mounted.current || epoch !== generation.current) return;
        updateDraft((d) => ({
          ...d,
          attachments: [...d.attachments, attachment],
        }));
      }
    } catch (e) {
      if (mounted.current && epoch === generation.current)
        setError(desktopError(e));
    } finally {
      if (mounted.current) {
        setFileBusy(false);
        if (visible.current && !work.current.locked)
          input.current?.focus({ preventScroll: true });
      }
    }
  }
  function receiveImage(value: IncomingImage) {
    if (seen.current.has(value.id)) return;
    seen.current.add(value.id);
    pending.current.push(value);
    setPendingCount(pending.current.length);
    void drainImages();
  }
  async function drainImages(retry = false) {
    if (
      imageWorking.current ||
      work.current.busy ||
      work.current.uploading ||
      work.current.locked ||
      !pending.current.length
    )
      return;
    const item = pending.current[0];
    if (item.failed && !retry) return;
    imageWorking.current = true;
    setFileBusy(true);
    setError("");
    const epoch = generation.current;
    try {
      if (!item.attachment) {
        if (current.current.attachments.length >= 4)
          throw new Error("附件已满，请移除一个附件，再添加暂存截图");
        item.attachment = await addDesktopFile(await imageFile(item.dataUrl));
      }
      if (!mounted.current || epoch !== generation.current) return;
      const attachment = item.attachment;
      if (!current.current.attachments.some((a) => a.id === attachment.id))
        updateDraft((d) => ({
          ...d,
          attachments: [...d.attachments, attachment],
        }));
      if (item.action !== "attach") {
        const run = await api<Run>("/desktop/actions", "POST", {
          action: item.action,
          attachment_id: attachment.id,
          model_selection: selectedModel(settings, current.current.modelKey),
        });
        if (!mounted.current || epoch !== generation.current) {
          void api(`/runs/${run.id}/cancel`, "POST");
          return;
        }
        updateDraft((d) => ({ ...d, runId: run.id }));
        setQuestion(item.action === "ocr" ? "提取截图文字" : "翻译截图");
        pending.current.shift();
        setPendingCount(pending.current.length);
        setFileBusy(false);
        await track(run.id, epoch);
      } else {
        pending.current.shift();
        setPendingCount(pending.current.length);
      }
    } catch (e) {
      if (mounted.current && epoch === generation.current) {
        item.failed = true;
        setError(desktopError(e));
      }
    } finally {
      imageWorking.current = false;
      if (mounted.current && epoch === generation.current) {
        setFileBusy(false);
        if (pending.current[0] && !pending.current[0].failed)
          void drainImages();
      }
    }
  }
  function acceptVoice(value: VoiceState) {
    setVoice(value);
    if (value.phase === "ready") void functions.current.transcribe(value.id);
    if (value.phase === "error") {
      work.current.locked = false;
      setError(value.error || "录音失败");
    }
  }
  async function startVoice(gesture?: number) {
    if (work.current.locked || work.current.uploading || work.current.busy)
      return;
    work.current.locked = true;
    setError("");
    const epoch = ++voiceEpoch.current;
    startingVoice.current = true;
    pendingVoice.current = null;
    voiceRange.current = {
      start: input.current?.selectionStart ?? current.current.text.length,
      end: input.current?.selectionEnd ?? current.current.text.length,
      text: current.current.text,
    };
    setVoice({ id: "", phase: "starting", seconds: 0, level: 0 });
    try {
      const id = await invoke<string>("voice_start", { gesture });
      if (epoch !== voiceEpoch.current || !mounted.current) {
        await invoke("voice_cancel", { id });
        return;
      }
      voiceId.current = id;
      startingVoice.current = false;
      const early = pendingVoice.current as VoiceState | null;
      if (early?.id === id) acceptVoice(early);
      else setVoice({ id, phase: "recording", seconds: 0, level: 0 });
      if (gesture !== undefined && heldGesture.current !== gesture)
        await invoke("voice_stop", { id });
    } catch (e) {
      if (epoch !== voiceEpoch.current || !mounted.current) return;
      startingVoice.current = false;
      work.current.locked = false;
      setVoice(null);
      if (!desktopError(e).includes("手势已结束")) setError(desktopError(e));
    }
  }
  async function transcribe(id: string) {
    if (voiceId.current !== id || request.current) return;
    work.current.locked = true;
    const epoch = voiceEpoch.current;
    setVoice((v) => v && { ...v, phase: "transcribing" });
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 80000);
    if (current.current.text !== voiceRange.current.text)
      voiceRange.current = {
        text: current.current.text,
        start: input.current?.selectionStart ?? current.current.text.length,
        end: input.current?.selectionEnd ?? current.current.text.length,
      };
    try {
      const bytes = await invoke<ArrayBuffer | number[]>("voice_audio_get", {
        id,
      });
      if (voiceId.current !== id || epoch !== voiceEpoch.current) return;
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
      if (
        !mounted.current ||
        voiceId.current !== id ||
        epoch !== voiceEpoch.current ||
        result.request_id !== id
      )
        return;
      const r = voiceRange.current;
      updateDraft((d) => ({
        ...d,
        text: d.text.slice(0, r.start) + result.text + d.text.slice(r.end),
      }));
      voiceId.current = "";
      setVoice(null);
      await invoke("voice_cancel", { id });
      if (visible.current) input.current?.focus({ preventScroll: true });
    } catch (e) {
      if (
        mounted.current &&
        voiceId.current === id &&
        epoch === voiceEpoch.current
      ) {
        setVoice((v) => v && { ...v, phase: "error", retryable: true });
        setError(
          controller.signal.aborted
            ? "识别超时，录音已保留，可重试或取消。"
            : desktopError(e),
        );
      }
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) request.current = null;
      if (epoch === voiceEpoch.current) work.current.locked = false;
    }
  }
  function cancelVoice() {
    const id = voiceId.current;
    voiceEpoch.current++;
    voiceId.current = "";
    heldGesture.current = null;
    startingVoice.current = false;
    pendingVoice.current = null;
    request.current?.abort();
    request.current = null;
    work.current.locked = false;
    setVoice(null);
    void invoke("voice_cancel", { id: id || undefined });
  }
  function newChat() {
    if (work.current.busy || work.current.locked || work.current.uploading)
      return;
    generation.current++;
    viewReady.current = true;
    pending.current = [];
    setPendingCount(0);
    updateDraft({
      text: "",
      attachments: [],
      conversationId: null,
      runId: null,
      modelKey: current.current.modelKey,
    });
    setAnswer("");
    setQuestion("");
    setError("");
  }
  const voiceBusy = Boolean(voice && voice.phase !== "error");
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
                <button aria-label="收起问答" onClick={() => void dismiss()}>
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
                  <Picture
                    key={`${a.id}:${hiddenEpoch}`}
                    id={a.id}
                    name={a.name}
                  />
                ) : (
                  <span>{a.name}</span>
                )}
                <Hint label="移除附件">
                  <button
                    aria-label="移除附件"
                    disabled={busy || uploading}
                    onClick={() =>
                      updateDraft((d) => ({
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
            readOnly={Boolean(voiceBusy)}
            onChange={(e) =>
              updateDraft((d) => ({ ...d, text: e.target.value }))
            }
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
              disabled={busy || uploading || Boolean(voiceBusy)}
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
                if (voice?.phase === "recording")
                  void invoke("voice_stop", { id: voiceId.current });
                else {
                  heldGesture.current = null;
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
              updateDraft((d) => ({ ...d, modelKey: e.target.value }))
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
                disabled={busy || uploading || Boolean(voiceBusy)}
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
                  void dismiss();
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
            {voice.phase === "error" && voice.retryable && (
              <button onClick={() => void transcribe(voice.id)}>
                <RotateCw size={14} />
                重试
              </button>
            )}
            <button onClick={cancelVoice}>取消</button>
          </div>
        )}
        {uploading && (
          <p className="quick-activity" role="status">
            正在添加附件…
          </p>
        )}
        {pendingCount > 0 && !uploading && (
          <div className="quick-pending">
            <span>有 {pendingCount} 张暂存截图</span>
            <button
              disabled={busy || voiceBusy}
              onClick={() => void drainImages(true)}
            >
              继续添加
            </button>
            <button
              onClick={() => {
                pending.current = [];
                setPendingCount(0);
              }}
            >
              移除暂存
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
