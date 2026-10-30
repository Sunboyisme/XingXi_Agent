import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUp,
  X,
  Copy,
  Check,
  Loader2,
  ExternalLink,
  ArrowUpRight,
  ScanLine,
  ChevronDown,
  ChevronUp,
  SquarePen,
} from "lucide-react";
import { BaiAvatar } from "./BaiAvatar";
import { useAvatarActivity } from "@/lib/useAvatarActivity";
import { useDesktopTaskRead } from "@/lib/useDesktopTaskRead";
import { useCopyFeedback } from "@/lib/clipboard";
import { isActiveRun } from "@/lib/avatarActivity";
import { Hint, Markdown } from "./common";
import { Picture } from "./ImageAttachments";
import { SpeechInputButton } from "./SpeechInputButton";
import { Reasoning } from "./Reasoning";
import { useSpeechInput } from "@/lib/useSpeechInput";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
import { nativeFile, useNativeDrop } from "@/lib/nativeDrop";
import {
  api,
  invoke,
  desktopListen,
  desktopError,
  emptyQuickDraft,
  models,
  selectedModel,
  addDesktopFile,
  imageFile,
  readEvents,
  type QuickDraft,
  type Settings,
  type Run,
  type Attachment,
} from "@/lib/desktopAssistant";
import type { RunEvent } from "@/lib/api";
type IncomingImage = {
  id: string;
  dataUrl: string;
  action: "attach" | "ocr" | "translate";
  attachment?: Attachment;
  failed?: boolean;
};
type QuickCommand = { id: string; sessionId: string } & (
  | { action: "voice"; gesture?: number | null }
  | {
      action: "image";
      dataUrl: string;
      imageAction: "attach" | "ocr" | "translate";
    }
  | { action: "resume"; runId: string }
);
export function DesktopQuickAsk() {
  const [draft, setDraft] = useState<QuickDraft>(emptyQuickDraft);
  const [sessionId, setSessionId] = useState("");
  const session = useRef("");
  const avatar = useAvatarActivity(`quick:${sessionId}`, "quick");
  const commandsWorking = useRef(false);
  const commandsPending = useRef(false);
  const [settings, setSettings] = useState<Settings>();
  const [answer, setAnswer] = useState("");
  const { copied, error: copyError, copy } = useCopyFeedback(answer);
  const [reasoning, setReasoning] = useState("");
  const [reasoningActive, setReasoningActive] = useState(false);
  const [reasoningIncomplete, setReasoningIncomplete] = useState(false);
  const [openingMain, setOpeningMain] = useState(false);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [answerCollapsed, setAnswerCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopRequest = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [readingFiles, setReadingFiles] = useState(false);
  const nativeReading = useRef(false);
  const [surfaceVisible, setSurfaceVisible] = useState(false);
  const [creatingChat, setCreatingChat] = useState(false);
  const creatingChatLock = useRef(false);
  const dropTarget = useRef<HTMLDivElement>(null);
  const fileFingerprints = useRef(new Map<string, string>());
  const [pendingCount, setPendingCount] = useState(0);
  const [hiddenEpoch, setHiddenEpoch] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const answerScroll = useRef<HTMLDivElement>(null);
  const followingAnswer = useRef(true);
  const resumeRequest = useRef(0);
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
    isBlocked: () =>
      work.current.busy ||
      work.current.uploading ||
      nativeReading.current ||
      creatingChatLock.current,
    isVisible: () => visible.current,
  });
  const { voice } = speech;
  const functions = useRef({
    startVoice: speech.start,
    receiveImage,
    shown,
    drainImages,
    resetSession,
    drainCommands,
    resumeTask,
  });
  functions.current = {
    startVoice: speech.start,
    receiveImage,
    shown,
    drainImages,
    resetSession,
    drainCommands,
    resumeTask,
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
      busy:
        busy ||
        uploading ||
        readingFiles ||
        Boolean(voice && voice.phase !== "error"),
    }).catch(() => {});
  }, [sessionId, busy, uploading, readingFiles, voice?.phase]);
  useEffect(() => {
    if (!busy && !uploading && !readingFiles && !voice)
      void functions.current.drainImages();
  }, [busy, uploading, readingFiles, voice, pendingCount]);
  useEffect(() => {
    if (sessionId) void functions.current.drainCommands();
  }, [sessionId]);
  useEffect(() => {
    const element = answerScroll.current;
    if (element && followingAnswer.current)
      element.scrollTop = element.scrollHeight;
  }, [answer, reasoning, answerCollapsed]);
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
        setSurfaceVisible(false);
        nativeReading.current = false;
        setReadingFiles(false);
        avatar.clearCelebration();
        cancelVoice();
        setHiddenEpoch((value) => value + 1);
        setError("");
      }),
      desktopListen<{ focus?: boolean } | null>(
        "desktop-shown",
        (value) => void functions.current.shown(value?.focus !== false),
      ),
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
          await functions.current.shown(await getCurrentWindow().isFocused());
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
      listeners.forEach((p) => void p.then((f) => f()).catch(() => {}));
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
  async function shown(focus = true) {
    visible.current = true;
    setSurfaceVisible(true);
    if (
      focus &&
      document.hasFocus() &&
      mounted.current &&
      !work.current.locked &&
      !work.current.uploading &&
      !document.querySelector('[role="dialog"]')
    )
      input.current?.focus({ preventScroll: true });
    await refreshSettings(false);
    if (!mounted.current || !visible.current) return;
    if (
      focus &&
      document.hasFocus() &&
      mounted.current &&
      !work.current.locked &&
      !document.querySelector('[role="dialog"]')
    )
      input.current?.focus({ preventScroll: true });
  }
  async function dismiss() {
    cancelVoice();
    visible.current = false;
    setSurfaceVisible(false);
    avatar.clearCelebration();
    setError("");
    try {
      await invoke("desktop_dismiss");
    } catch (cause) {
      if (mounted.current) {
        visible.current = true;
        setSurfaceVisible(true);
        setError(desktopError(cause));
      }
    }
  }
  async function resumeTask(id: string) {
    setAnswerCollapsed(false);
    if (work.current.busy && current.current.runId === id) return;
    if (work.current.busy)
      throw new Error("当前问答正在处理另一项任务，请先完成或停止它。");
    const epoch = generation.current;
    const request = ++resumeRequest.current;
    const run = await api<Run>(`/runs/${id}`);
    if (
      !mounted.current ||
      epoch !== generation.current ||
      request !== resumeRequest.current ||
      work.current.busy
    )
      return;
    avatar.clearCelebration();
    followingAnswer.current = true;
    setReasoning("");
    setReasoningActive(false);
    setReasoningIncomplete(run.status !== "completed");
    setError(run.error || "");
    setQuestion("桌面任务");
    updateDraft((value) => ({
      ...value,
      conversationId: run.conversation_id || null,
    }));
    if (isActiveRun(run.status)) {
      updateDraft((value) => ({ ...value, runId: id }));
      await track(run, epoch);
    } else {
      const text = run.result?.text;
      setAnswer(typeof text === "string" ? text : "");
      setError(run.error || "");
      try {
        const history = await api<RunEvent[]>(`/runs/${id}/tools`);
        if (
          !mounted.current ||
          epoch !== generation.current ||
          request !== resumeRequest.current ||
          work.current.busy
        )
          return;
        const steps = new Map<string, string>();
        history
          .filter((event) => event.kind === "reasoning")
          .forEach((event) => {
            const step = String(event.data.step || "");
            steps.set(
              step,
              (steps.get(step) || "") + String(event.data.text || ""),
            );
          });
        setReasoning([...steps.values()].join("\n\n"));
      } catch {
        if (
          mounted.current &&
          epoch === generation.current &&
          request === resumeRequest.current &&
          !work.current.busy &&
          !run.error
        )
          setError("回答已恢复，思考内容暂未加载，请稍后重新打开。");
      }
    }
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
    fileFingerprints.current.clear();
    nativeReading.current = false;
    setReadingFiles(false);
    imageWorking.current = false;
    setPendingCount(0);
    setRunBusy(false);
    setSubmitting(false);
    setStopping(false);
    stopRequest.current = false;
    setFileBusy(false);
    updateDraft(emptyQuickDraft());
    setAnswer("");
    setReasoning("");
    setReasoningActive(false);
    setReasoningIncomplete(false);
    setOpeningMain(false);
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
        // Native keeps typed actions until this session is ready. Drafts stay in the AI surface.
        for (const item of items) {
          if (item.sessionId !== session.current) continue;
          if (item.action === "voice")
            void functions.current.startVoice(item.gesture ?? undefined);
          else if (item.action === "image")
            functions.current.receiveImage({
              id: item.id,
              dataUrl: item.dataUrl,
              action: item.imageAction,
            });
          else if (item.action === "resume")
            void functions.current.resumeTask(item.runId).catch((cause) => {
              if (mounted.current && item.sessionId === session.current)
                setError(desktopError(cause));
            });
        }
      }
    } catch (e) {
      if (mounted.current) setError(desktopError(e));
    } finally {
      commandsWorking.current = false;
    }
  }
  async function track(run: Run, epoch: number) {
    const id = run.id;
    setAnswerCollapsed(false);
    const sequence = ++tracking.current;
    tracker.current?.abort();
    const controller = new AbortController();
    tracker.current = controller;
    setRunBusy(true);
    followingAnswer.current = true;
    setAnswer("");
    setReasoning("");
    setReasoningActive(false);
    setReasoningIncomplete(false);
    let reasoningStep = "";
    avatar.begin(run);
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
          if (e.kind === "reasoning") {
            const step = String(e.data.step || "");
            const separator =
              reasoningStep && step !== reasoningStep ? "\n\n" : "";
            reasoningStep = step;
            setReasoning(
              (text) => text + separator + String(e.data.text || ""),
            );
            setReasoningActive(true);
          }
          if (e.kind === "delta") {
            setReasoningActive(false);
            setAnswer((a) => a + String(e.data.text || ""));
          }
          if (e.kind === "answer") {
            setReasoningActive(false);
            setAnswer(String(e.data.text || ""));
          }
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
        setReasoningIncomplete(result.status !== "completed");
        if (text) setAnswer(text);
        if (result.error) setError(result.error);
        avatar.finish(result, visible.current);
        if (typeof result.result.next_run_id === "string") {
          const next = await api<Run>(`/runs/${result.result.next_run_id}`);
          if (
            mounted.current &&
            epoch === generation.current &&
            sequence === tracking.current
          ) {
            updateDraft((d) => ({ ...d, runId: next.id }));
            await track(next, epoch);
          }
        }
      }
    } catch (e) {
      if (
        !controller.signal.aborted &&
        mounted.current &&
        epoch === generation.current &&
        sequence === tracking.current
      ) {
        avatar.finish({ ...run, status: "interrupted" }, visible.current);
        setReasoningIncomplete(true);
        setError(desktopError(e));
      }
    } finally {
      if (
        mounted.current &&
        epoch === generation.current &&
        sequence === tracking.current
      ) {
        setRunBusy(false);
        setReasoningActive(false);
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
      nativeReading.current ||
      creatingChatLock.current ||
      (!value.text.trim() && !value.attachments.length)
    )
      return;
    startRequest.current = true;
    setSubmitting(true);
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
      setSubmitting(false);
      await track(run, epoch);
    } catch (e) {
      if (mounted.current && epoch === generation.current) {
        setRunBusy(false);
        setError(desktopError(e));
      }
    } finally {
      if (epoch === generation.current) {
        startRequest.current = false;
        setSubmitting(false);
      }
    }
  }
  async function stop() {
    const id = current.current.runId;
    const epoch = generation.current;
    if (!id || stopRequest.current) return;
    stopRequest.current = true;
    setStopping(true);
    try {
      await api(`/runs/${id}/cancel`, "POST");
    } catch (e) {
      if (mounted.current && epoch === generation.current)
        setError(desktopError(e));
    } finally {
      if (mounted.current && epoch === generation.current) {
        stopRequest.current = false;
        setStopping(false);
      }
    }
  }
  async function uploadFiles(files: File[], epoch: number) {
    const unique = new Map<string, File>();
    for (const file of files) {
      const path =
        (file as File & { nativePath?: string }).nativePath || file.name;
      const key = `${path}:${file.size}:${file.lastModified}`;
      const attachedId = fileFingerprints.current.get(key);
      if (
        !attachedId ||
        !current.current.attachments.some((item) => item.id === attachedId)
      )
        unique.set(key, file);
    }
    if (unique.size + current.current.attachments.length > 4)
      throw new Error("每次最多提交 4 个附件");
    for (const [key, file] of unique) {
      if (!mounted.current || epoch !== generation.current) return;
      const attachment = await addDesktopFile(file);
      if (!mounted.current || epoch !== generation.current) return;
      fileFingerprints.current.set(key, attachment.id);
      updateDraft((value) => ({
        ...value,
        attachments: [...value.attachments, attachment],
      }));
    }
  }
  async function newChat() {
    if (
      work.current.busy ||
      work.current.uploading ||
      work.current.locked ||
      nativeReading.current ||
      creatingChatLock.current
    )
      return;
    creatingChatLock.current = true;
    setCreatingChat(true);
    setError("");
    try {
      await invoke("desktop_start", { newChat: true });
    } catch (cause) {
      if (mounted.current) setError(desktopError(cause));
    } finally {
      creatingChatLock.current = false;
      if (mounted.current) setCreatingChat(false);
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
      nativeReading.current ||
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
        item.dataUrl = "";
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
        await track(run, epoch);
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
  async function openMain() {
    if (openingMain) return;
    const epoch = generation.current;
    setOpeningMain(true);
    try {
      const conversationId = current.current.conversationId;
      await invoke(
        "desktop_main",
        conversationId ? { conversationId } : { page: "current" },
      );
    } catch (error) {
      if (mounted.current && epoch === generation.current)
        setError(desktopError(error));
    } finally {
      if (mounted.current && epoch === generation.current)
        setOpeningMain(false);
    }
  }
  const voiceBusy = Boolean(voice && voice.phase !== "error");
  const filesBusy = uploading || readingFiles;
  useNativeDrop(
    dropTarget,
    async (files) => {
      const epoch = generation.current;
      setFileBusy(true);
      setError("");
      try {
        if (files.some((file) => file.directory))
          throw new Error("请拖入文件；桌面问答暂不支持文件夹");
        await uploadFiles(files.map(nativeFile), epoch);
      } catch (cause) {
        if (mounted.current && epoch === generation.current)
          setError(desktopError(cause));
      } finally {
        if (mounted.current && epoch === generation.current) setFileBusy(false);
      }
    },
    setError,
    false,
    !surfaceVisible ||
      !sessionId ||
      busy ||
      uploading ||
      voiceBusy ||
      creatingChat,
    `${sessionId}:${hiddenEpoch}`,
    (value) => {
      nativeReading.current = value;
      setReadingFiles(value);
    },
  );
  const hasAnswer = Boolean(answer || reasoning || busy || error);
  useDesktopTaskRead(
    draft.conversationId,
    Boolean(answer) && !answerCollapsed,
    input,
  );
  return (
    <main className="quick-window">
      {hasAnswer && !answerCollapsed && (
        <section className="quick-answer" id="desktop-quick-answer">
          <header>
            <strong>{question || "XiaoXi"}</strong>
            <div>
              <Hint label={copied ? "已复制" : "复制回答"}>
                <button
                  aria-label={copied ? "已复制回答" : "复制回答"}
                  disabled={!answer}
                  onClick={() => void copy()}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </Hint>
              <span className="sr-only" role="status">
                {copied ? "回答已复制" : ""}
              </span>
              <Hint
                label={
                  draft.conversationId
                    ? "在主窗口打开这段对话，继续提问或查看完整内容"
                    : "打开 XiaoXi 主窗口"
                }
              >
                <button
                  className="quick-open-main"
                  aria-label={
                    draft.conversationId ? "在主窗口继续对话" : "打开主窗口"
                  }
                  disabled={openingMain}
                  onClick={() => void openMain()}
                >
                  <ArrowUpRight size={17} aria-hidden="true" />
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
          <div
            className="quick-answer-scroll"
            ref={answerScroll}
            role="region"
            aria-label="桌面问答内容"
            tabIndex={0}
            onWheel={(event) => {
              if (event.deltaY < 0) followingAnswer.current = false;
            }}
            onScroll={(event) => {
              const element = event.currentTarget;
              followingAnswer.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                24;
            }}
          >
            <Reasoning
              text={reasoning}
              active={reasoningActive}
              incomplete={!busy && reasoningIncomplete}
            />
            <Markdown>{answer}</Markdown>
            {busy && (
              <p className="quick-answer-status" role="status">
                {submitting
                  ? "正在提交…"
                  : stopping
                    ? "正在停止…"
                    : reasoningActive
                      ? "正在思考…"
                      : "正在回答…"}
              </p>
            )}
            {copyError && (
              <p className="desktop-error" role="alert">
                {copyError}
              </p>
            )}
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
                      }).catch((e) => setError(desktopError(e)));
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
      <div className="quick-composer-group" ref={dropTarget}>
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
                    disabled={busy || filesBusy || creatingChat}
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
          <BaiAvatar
            interactive
            activity={avatar.activity}
            motion={busy ? "thinking" : "idle"}
          />
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
          <button
            aria-label="截图"
            disabled={filesBusy || creatingChat}
            onClick={() =>
              void invoke("desktop_capture_begin").catch((e) =>
                setError(desktopError(e)),
              )
            }
          >
            <ScanLine size={19} />
          </button>
          <Hint label="新建对话">
            <button
              aria-label="新建对话"
              disabled={busy || filesBusy || voiceBusy || creatingChat}
              onClick={() => void newChat()}
            >
              {creatingChat ? (
                <Loader2 size={19} className="spin" />
              ) : (
                <SquarePen size={19} />
              )}
            </button>
          </Hint>
          <SpeechInputButton
            speech={speech}
            disabled={busy || filesBusy || creatingChat}
            desktopShortcut
          />
          <Hint
            label={
              submitting
                ? "正在提交，任务创建后可停止回答"
                : stopping
                  ? "正在停止回答"
                  : busy
                    ? "停止回答"
                    : "发送"
            }
          >
            <button
              className="quick-send composer-action"
              data-action={busy ? "stop" : "send"}
              aria-label={
                submitting
                  ? "正在提交"
                  : stopping
                    ? "正在停止回答"
                    : busy
                      ? "停止回答"
                      : "发送"
              }
              aria-disabled={submitting || stopping || undefined}
              aria-busy={submitting || stopping}
              disabled={
                !busy &&
                (filesBusy ||
                  creatingChat ||
                  Boolean(voiceBusy) ||
                  (!draft.text.trim() && !draft.attachments.length))
              }
              onClick={() => {
                if (!submitting && !stopping) void (busy ? stop() : send());
              }}
            >
              {submitting || stopping ? (
                <Loader2
                  size={18}
                  className="composer-action-icon composer-action-progress size-[18px]"
                  aria-hidden="true"
                />
              ) : busy ? (
                <span className="composer-action-stop" aria-hidden="true" />
              ) : (
                <ArrowUp
                  size={18}
                  strokeWidth={2}
                  className="composer-action-icon size-[18px]"
                  aria-hidden="true"
                />
              )}
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
        {readingFiles && (
          <p className="quick-pending" role="status">
            正在读取拖入的文件…
          </p>
        )}
        {pendingCount > 0 && !filesBusy && (
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
