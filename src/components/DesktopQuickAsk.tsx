import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUp,
  Plus,
  Square,
  X,
  Copy,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { BaiAvatar } from "./BaiAvatar";
import { Hint, Markdown } from "./common";
import { Picture } from "./ImageAttachments";
import { SpeechInputButton } from "./SpeechInputButton";
import { useSpeechInput } from "@/lib/useSpeechInput";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
import {
  api,
  invoke,
  emitTo,
  desktopListen,
  desktopError,
  emptyQuickDraft,
  models,
  selectedModel,
  addDesktopFile,
  imageFile,
  copyText,
  readEvents,
  type QuickDraft,
  type Settings,
  type Run,
  type Attachment,
} from "@/lib/desktopAssistant";
type IncomingImage = {
  id: string;
  dataUrl: string;
  action: string;
  attachment?: Attachment;
  failed?: boolean;
};
type QuickCommand = {
  id: string;
  sessionId: string;
  action: string;
  text?: string;
  dataUrl?: string;
  gesture?: number;
  imageAction?: string;
};
export function DesktopQuickAsk() {
  const [draft, setDraft] = useState<QuickDraft>(emptyQuickDraft);
  const [sessionId, setSessionId] = useState("");
  const session = useRef("");
  const commandsWorking = useRef(false);
  const commandsPending = useRef(false);
  const [settings, setSettings] = useState<Settings>();
  const [answer, setAnswer] = useState("");
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [answerCollapsed, setAnswerCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [hiddenEpoch, setHiddenEpoch] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const current = useRef(draft);
  const mounted = useRef(false);
  const visible = useRef(false);
  const generation = useRef(0);
  const tracking = useRef(0);
  const work = useRef({ busy: false, uploading: false, locked: false });
  const startRequest = useRef(false);
  const tracker = useRef<AbortController | null>(null);
  const pending = useRef<IncomingImage[]>([]);
  const seen = useRef(new Set<string>());
  const imageWorking = useRef(false);
  const speech = useSpeechInput({
    scopeKey: sessionId,
    input,
    readText: () => current.current.text,
    writeText: (text) => updateDraft((d) => ({ ...d, text })),
    onError: setError,
    onLockChange: (locked) => {
      work.current.locked = locked;
    },
    onBegin: () => setAnswerCollapsed(false),
    isBlocked: () => work.current.busy || work.current.uploading,
    isVisible: () => visible.current,
  });
  const { voice } = speech;
  const functions = useRef({
    send,
    startVoice: speech.start,
    receiveImage,
    pickFiles,
    shown,
    drainImages,
    resetSession,
    drainCommands,
  });
  functions.current = {
    send,
    startVoice: speech.start,
    receiveImage,
    pickFiles,
    shown,
    drainImages,
    resetSession,
    drainCommands,
  };
  useDesktopHitRegions(
    ".quick-answer,.quick-composer-group,.ui-hint,[role=dialog],[role=listbox],[role=menu],[data-slot=dialog-overlay]",
  );
  function updateDraft(change: QuickDraft | ((d: QuickDraft) => QuickDraft)) {
    const next =
      typeof change === "function" ? change(current.current) : change;
    current.current = next;
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
    if (!sessionId) return;
    void invoke("desktop_quick_state", {
      sessionId,
      text: draft.text,
      busy: busy || uploading || Boolean(voice && voice.phase !== "error"),
    }).catch(() => {});
  }, [sessionId, draft.text, busy, uploading, voice?.phase]);
  useEffect(() => {
    if (!busy && !uploading && !voice) void functions.current.drainImages();
  }, [busy, uploading, voice, pendingCount]);
  useEffect(() => {
    if (sessionId) void functions.current.drainCommands();
  }, [sessionId]);
  useEffect(() => {
    mounted.current = true;
    const listeners = [
      desktopListen<string>("desktop-error", (v) => {
        if (mounted.current) setError(v);
      }),
      desktopListen<{ id: string }>("desktop-session", (v) => {
        functions.current.resetSession(v.id);
        void functions.current.drainCommands();
      }),
      desktopListen<{ sessionId: string }>("desktop-command", (v) => {
        if (v.sessionId === session.current)
          void functions.current.drainCommands();
      }),
      desktopListen<{ gesture: number }>("desktop-release", (v) =>
        speech.release(v.gesture),
      ),
      desktopListen("desktop-voice-cancel", () => cancelVoice()),
      desktopListen<{ sessionId: string }>("desktop-hidden", (v) => {
        if (v.sessionId !== session.current) return;
        visible.current = false;
        cancelVoice();
        setHiddenEpoch((value) => value + 1);
        setError("");
      }),
      desktopListen("desktop-shown", () => void functions.current.shown()),
    ];
    void Promise.all(listeners)
      .then(async () => {
        if (!mounted.current) return;
        const id = await invoke<string>("desktop_ask_session");
        if (!mounted.current) return;
        // An event received while this request was in flight is newer than its result.
        if (!session.current) functions.current.resetSession(id);
        await functions.current.drainCommands();
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
      void dismiss();
    };
    window.addEventListener("keydown", key);
    return () => {
      mounted.current = false;
      visible.current = false;
      generation.current++;
      tracking.current++;
      tracker.current?.abort();
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
  function resetSession(id: string) {
    if (!id || id === session.current) return;
    session.current = id;
    setSessionId(id);
    generation.current++;
    tracking.current++;
    tracker.current?.abort();
    cancelVoice();
    startRequest.current = false;
    pending.current = [];
    seen.current.clear();
    imageWorking.current = false;
    setPendingCount(0);
    setRunBusy(false);
    setFileBusy(false);
    updateDraft(emptyQuickDraft());
    setAnswer("");
    setQuestion("");
    setError("");
    setAnswerCollapsed(false);
    setHiddenEpoch((value) => value + 1);
  }
  async function drainCommands() {
    commandsPending.current = true;
    if (
      commandsWorking.current ||
      !session.current ||
      sessionId !== session.current
    )
      return;
    commandsWorking.current = true;
    try {
      while (commandsPending.current && mounted.current) {
        commandsPending.current = false;
        const id = session.current;
        const items = await invoke<QuickCommand[]>("desktop_commands_take", {
          sessionId: id,
        });
        if (!mounted.current || id !== session.current) continue;
        // Actions may arrive before this hidden WebView has finished mounting.
        // Native keeps them until the listener is ready, including the final draft text.
        for (const item of items) {
          if (item.sessionId !== session.current) continue;
          const text = item.text;
          if (typeof text === "string") updateDraft((d) => ({ ...d, text }));
          if (item.action === "send") void functions.current.send();
          if (item.action === "file") void functions.current.pickFiles();
          if (item.action === "voice" || item.action === "record") {
            void functions.current.startVoice(item.gesture);
          }
          if (item.action === "image" && item.dataUrl)
            functions.current.receiveImage({
              id: item.id,
              dataUrl: item.dataUrl,
              action: item.imageAction || "attach",
            });
        }
      }
    } catch (e) {
      if (mounted.current) setError(desktopError(e));
    } finally {
      commandsWorking.current = false;
    }
  }
  async function track(id: string, epoch: number) {
    setAnswerCollapsed(false);
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
    setAnswerCollapsed(false);
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
          "当前模型不支持图片，请在设置中更换支持图片的默认模型。截图和文字已保留。",
        );
      let id = value.conversationId;
      if (!id) {
        id = (
          await api<{ id: string }>("/conversations", "POST", {
            title: "新对话",
          })
        ).id;
        if (mounted.current && epoch === generation.current)
          updateDraft((d) => ({ ...d, conversationId: id }));
      }
      const text = value.text.trim() || "请根据这张截图或附件帮助我分析。";
      const run = await api<Run>(`/conversations/${id}/messages`, "POST", {
        content: text,
        attachment_ids: value.attachments.map((a) => a.id),
        model_selection: selected,
      });
      if (!mounted.current || epoch !== generation.current) return;
      updateDraft((d) => ({
        ...d,
        conversationId: id,
        text: d.text === value.text ? "" : d.text,
        attachments: d.attachments.filter(
          (a) => !value.attachments.some((sent) => sent.id === a.id),
        ),
        runId: run.id,
      }));
      setQuestion(text);
      await track(run.id, epoch);
    } catch (e) {
      if (mounted.current && epoch === generation.current) {
        setRunBusy(false);
        setError(desktopError(e));
      }
    } finally {
      if (epoch === generation.current) startRequest.current = false;
    }
  }
  async function stop() {
    const id = current.current.runId;
    const epoch = generation.current;
    if (id)
      try {
        await api(`/runs/${id}/cancel`, "POST");
      } catch (e) {
        if (mounted.current && epoch === generation.current)
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
      if (!mounted.current || epoch !== generation.current) return;
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
      if (mounted.current && epoch === generation.current) {
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
          void api(`/runs/${run.id}/cancel`, "POST").catch(() => {});
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
      if (mounted.current && epoch === generation.current) {
        imageWorking.current = false;
        setFileBusy(false);
        if (pending.current[0] && !pending.current[0].failed)
          void drainImages();
      }
    }
  }
  function cancelVoice() {
    speech.cancel();
  }
  const voiceBusy = Boolean(voice && voice.phase !== "error");
  const hasAnswer = Boolean(answer || busy || error);
  return (
    <main className="quick-window">
      {hasAnswer && !answerCollapsed && (
        <section className="quick-answer" id="desktop-quick-answer">
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
              <Hint label="收起回答">
                <button
                  aria-label="收起回答"
                  aria-controls="desktop-quick-answer"
                  onClick={() => {
                    setAnswerCollapsed(true);
                    input.current?.focus({ preventScroll: true });
                  }}
                >
                  <ChevronDown size={16} />
                </button>
              </Hint>
            </div>
          </header>
          <div className="quick-answer-scroll">
            <Markdown>{answer}</Markdown>
            {busy && <p role="status">正在处理…</p>}
            {error && (
              <div className="quick-error" role="alert">
                <p className="desktop-error">{error}</p>
                {/配置语音|语音.*API Key/.test(error) && (
                  <button
                    className="quick-settings-link"
                    onClick={() => {
                      void invoke("desktop_main", {
                        settings: true,
                        settingsTab: "services",
                      })
                        .then(() => dismiss())
                        .catch((e) => setError(desktopError(e)));
                    }}
                  >
                    配置语音服务 <ExternalLink size={14} />
                  </button>
                )}
              </div>
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
          <SpeechInputButton
            speech={speech}
            disabled={busy || uploading}
            desktopShortcut
          />
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
          <Hint label="关闭问答">
            <button aria-label="关闭问答" onClick={() => void dismiss()}>
              <X size={19} />
            </button>
          </Hint>
          {hasAnswer && answerCollapsed && (
            <Hint label="展开回答">
              <button
                aria-label="展开回答"
                aria-expanded={false}
                aria-controls="desktop-quick-answer"
                onClick={() => {
                  setAnswerCollapsed(false);
                  input.current?.focus({ preventScroll: true });
                }}
              >
                <ChevronUp size={19} />
              </button>
            </Hint>
          )}
        </div>
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
