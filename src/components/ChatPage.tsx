import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Cable,
  Check,
  ChevronDown,
  Image as ImageIcon,
  LoaderCircle,
  Settings2,
  Square,
  Sparkles,
} from "lucide-react";
import { DropdownMenu, Tooltip } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  readEvents,
  type Conversation,
  type Message,
  type Run,
  type RunEvent,
  type Settings,
  type Attachment,
  type CalendarEvent,
  type Goal,
  type Memory,
  type ComplexTask,
} from "@/lib/api";
import { ErrorNotice, Hint, ImagesInput, Markdown } from "./common";
import { MessageAttachment } from "./OfficeFiles";
import { ToolboxMenu } from "./ToolboxMenu";
import { SkillsMenu } from "./SkillsMenu";
import { Reasoning } from "./Reasoning";
import { AnswerPresentation } from "./AnswerPresentation";
import { AnswerActions } from "./AnswerActions";
import { UserMessageActions } from "./UserMessageActions";
import { BaiAvatar } from "./BaiAvatar";
import { ChatHome } from "./ChatHome";
import { TaskCard } from "./TaskCard";
import {
  MemoryReview,
  MemorySavedNotice,
  type MemoryNotice,
} from "./MemoryFeedback";

function IncompleteReplyNotice({
  cancelled,
  onRetry,
  disabled,
}: {
  cancelled: boolean;
  onRetry?: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`incomplete-reply-notice ${cancelled ? "is-cancelled" : "is-failed"}`}
      role="status"
    >
      <AlertCircle size={15} />
      <div>
        <strong>{cancelled ? "回答停在这里" : "这次回答没有完成"}</strong>
        <p>
          {!onRetry
            ? "已有内容保留，可以发送新要求继续。"
            : cancelled
              ? "已经完成的工具操作仍会保留，可以继续追问或重新生成。"
              : "可以重新生成，或者换个说法继续。"}
        </p>
      </div>
      {onRetry && (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onRetry}>
          重新生成
        </Button>
      )}
    </div>
  );
}

function isRunErrorDismissed(runId: string) {
  try {
    return sessionStorage.getItem(`bai-dismissed-chat-error:${runId}`) === "1";
  } catch {
    return false;
  }
}

type StoredChatDraft = {
  text: string;
  images: Attachment[];
};

function readModelPreference(conversationId: string | null) {
  try {
    const value = JSON.parse(
      localStorage.getItem(`bai-chat-model:${conversationId || "new"}`) ||
        "null",
    );
    return value?.version === 1 && typeof value.key === "string"
      ? { key: value.key, thinking: value.thinking === true }
      : null;
  } catch {
    return null;
  }
}

function storeModelPreference(
  conversationId: string | null,
  key: string,
  thinking: boolean,
) {
  try {
    localStorage.setItem(
      `bai-chat-model:${conversationId || "new"}`,
      JSON.stringify({ version: 1, key, thinking }),
    );
  } catch {
    /* Storage restrictions must not block model selection. */
  }
}

type ImageGenerationProgress = {
  status: "started" | "progress" | "finished";
  stage: string;
  startedAt: number;
  elapsedSeconds?: number;
  error?: string;
};

const imageStageLabels: Record<string, string> = {
  submit: "正在提交画面描述",
  generate: "正在生成图片",
  download: "正在下载生成结果",
  validate: "正在检查图片",
  save: "正在保存到本机",
};

function ImageGenerationPreview({
  progress,
}: {
  progress: ImageGenerationProgress;
}) {
  const [now, setNow] = useState(Date.now());
  const finished = progress.status === "finished";
  const failed = finished && Boolean(progress.error);
  useEffect(() => {
    if (finished) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [finished]);
  const elapsed =
    progress.elapsedSeconds ??
    Math.max(0, Math.floor((now - progress.startedAt) / 1000));
  const label = failed
    ? "图片生成未完成"
    : finished
      ? "图片已生成"
      : imageStageLabels[progress.stage] || "正在生成图片";
  const detail = failed
    ? "尚未取得可展示的图片，稍后会显示具体结果。"
    : finished
      ? "正在整理图片说明，请稍候…"
      : progress.stage === "download"
        ? "模型已返回画面，正在取回完整图片。"
        : "完成后，图片会显示在这里。";
  const canvasLabel = failed
    ? "尚未取得图片"
    : finished
      ? "图片已生成"
      : progress.stage === "download"
        ? "正在取回完整图片"
        : progress.stage === "validate"
          ? "正在检查图片"
          : progress.stage === "save"
            ? "正在保存图片"
            : "等待生成图片中";
  return (
    <figure
      className="image-generation-preview"
      data-state={failed ? "error" : finished ? "finished" : "running"}
      aria-label={`${label}，${finished ? "用时" : "已等待"} ${elapsed} 秒`}
    >
      <span className="sr-only" role="status" aria-live="polite">
        {label}。{detail}
      </span>
      <div className="image-generation-canvas" aria-hidden="true">
        <ImageIcon size={27} strokeWidth={1.2} />
        <span>{canvasLabel}</span>
      </div>
      <figcaption>
        <span className="image-generation-status-icon" aria-hidden="true">
          {failed ? (
            <AlertCircle size={17} />
          ) : finished ? (
            <Check size={17} />
          ) : (
            <LoaderCircle size={17} />
          )}
        </span>
        <strong>{label}</strong>
        <span className="image-generation-elapsed">
          {finished ? `用时 ${elapsed} 秒` : `${elapsed} 秒`}
        </span>
      </figcaption>
    </figure>
  );
}

function chatDraftKey(conversationId: string | null) {
  return `bai-chat-draft:${conversationId || "new"}`;
}

function readChatDraft(conversationId: string | null): StoredChatDraft | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(chatDraftKey(conversationId)) || "null",
    );
    if (
      !value ||
      typeof value.text !== "string" ||
      !Array.isArray(value.images)
    )
      return null;
    return {
      text: value.text,
      images: value.images.filter(
        (image: Attachment) =>
          image &&
          typeof image.id === "string" &&
          typeof image.name === "string",
      ),
    };
  } catch {
    return null;
  }
}

function storeChatDraft(conversationId: string | null, value: StoredChatDraft) {
  try {
    if (!value.text && !value.images.length) {
      localStorage.removeItem(chatDraftKey(conversationId));
      return;
    }
    localStorage.setItem(chatDraftKey(conversationId), JSON.stringify(value));
  } catch {
    /* Draft persistence should never make the composer unusable. */
  }
}

function clearChatDraft(conversationId: string | null) {
  try {
    localStorage.removeItem(chatDraftKey(conversationId));
  } catch {
    /* Ignore storage failures in restricted windows. */
  }
}

function resizeMessageInput(input: HTMLTextAreaElement) {
  const scrollTop = input.scrollTop;
  input.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(input).maxHeight) || 180;
  if (!input.scrollHeight) return;
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  if (
    document.activeElement === input &&
    input.selectionEnd === input.value.length
  ) {
    input.scrollTop = input.scrollHeight;
  } else {
    input.scrollTop = scrollTop;
  }
}

function ReplyActivity({
  reasoning,
  stream,
  imageGeneration,
  runId,
}: {
  reasoning: string;
  stream: string;
  imageGeneration: ImageGenerationProgress | null;
  contextStatus: string;
  toolCount: number;
  runId?: string;
}) {
  return (
    <>
      <Reasoning text={reasoning} active />
      {imageGeneration && <ImageGenerationPreview progress={imageGeneration} />}
      {stream && <Markdown runId={runId}>{stream}</Markdown>}
      {!imageGeneration && !reasoning && (
        <div className="thinking" role="status" aria-live="polite">
          <span className="thinking-label">XiaoXi 正在思考</span>
          <span className="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      )}
    </>
  );
}

export function ChatPage({
  conversationId,
  onConversation,
  settings,
  goals,
  conversations = [],
  memories,
  refresh,
  onAction,
  onPlan,
  projectId = null,
  focusMessageId,
  onMessageFocused,
}: {
  projectId?: string | null;
  focusMessageId?: string | null;
  onMessageFocused?: () => void;
  conversationId: string | null;
  onConversation: (id: string) => void;
  settings: Settings;
  goals: Goal[];
  conversations?: Conversation[];
  memories?: Memory[];
  refresh: () => Promise<void>;
  onAction: (page: string, create?: boolean) => void;
  onPlan: (plan: CalendarEvent) => void;
}) {
  const [modelKey, setModelKey] = useState(
    () => readModelPreference(conversationId)?.key || "",
  );
  const [thinking, setThinking] = useState(
    () => readModelPreference(conversationId)?.thinking || false,
  );
  useEffect(() => {
    const saved = readModelPreference(conversationId);
    setModelKey(saved?.key || "");
    setThinking(saved?.thinking || false);
  }, [conversationId]);
  const choices = useMemo(
    () =>
      settings.providers.flatMap((profile) =>
        profile.models.map((model) => ({
          profile,
          model,
          key: `${profile.id}:${model.name}`,
        })),
      ),
    [settings.providers],
  );
  const selected =
    choices.find((x) => x.key === modelKey) ||
    choices.find(
      (x) =>
        x.profile.id === settings.default_provider &&
        x.model.name === x.profile.default_model,
    );
  const modelReady = Boolean(selected?.profile.key_configured);
  const thinkingControl = selected?.model.thinking_control || "none";
  const thinkingEnabled =
    thinkingControl === "always" || (thinkingControl !== "none" && thinking);
  const [messages, setMessages] = useState<Message[]>([]);
  const [initialDraft] = useState(() => readChatDraft(conversationId));
  const [draft, setDraft] = useState(initialDraft?.text || "");
  const [images, setImages] = useState<Attachment[]>(
    initialDraft?.images || [],
  );
  const [attachmentBatch, setAttachmentBatch] = useState(0);
  const [stream, setStream] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [tasks, setTasks] = useState<ComplexTask[]>([]);
  useEffect(() => {
    if (
      !focusMessageId ||
      !messages.some((message) => message.id === focusMessageId)
    )
      return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`chat-message-${focusMessageId}`);
      if (target) {
        followLatest.current = false;
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
        setAtLatest(false);
        onMessageFocused?.();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusMessageId, messages, onMessageFocused]);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const actionLock = useRef(false);
  const actionSequence = useRef(0);
  const updateTask = useCallback((value: ComplexTask) => {
    setTasks((items) => [
      value,
      ...items.filter((item) => item.id !== value.id),
    ]);
  }, []);
  const [contextStatus, setContextStatus] = useState("");
  const [tools, setTools] = useState<RunEvent[]>([]);
  const [imageGeneration, setImageGeneration] =
    useState<ImageGenerationProgress | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editedText, setEditedText] = useState("");
  const [atLatest, setAtLatest] = useState(true);
  const [activeTurn, setActiveTurn] = useState("");
  const turnElements = useRef(new Map<string, HTMLElement>());
  const scrollFrame = useRef(0);
  useEffect(
    () => () => {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = 0;
    },
    [conversationId],
  );
  const [uploading, setUploading] = useState(false);
  const [buddyNote, setBuddyNote] = useState("");
  const [composerMenu, setComposerMenu] = useState<"mcp" | "skills" | null>(
    null,
  );
  function changeComposerMenu(next: "mcp" | "skills", open: boolean) {
    if (open) {
      setComposerMenu(next);
      return;
    }
    setComposerMenu((current) => (current === next ? null : current));
  }
  const [memoryNotice, setMemoryNotice] = useState<MemoryNotice | null>(null);
  const closeMemoryNotice = useCallback(() => setMemoryNotice(null), []);
  const receiveMemory = useCallback((event: RunEvent) => {
    const { change_id, state, content, action } = event.data;
    if (state !== "confirmed" || typeof change_id !== "string") return;
    const key = `bai-memory-notice:${change_id}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "seen");
    setMemoryNotice({
      change_id,
      content: String(content || ""),
      action: String(action),
    });
  }, []);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (
      modelKey &&
      !settings.providers.some((profile) =>
        profile.models.some(
          (model) => `${profile.id}:${model.name}` === modelKey,
        ),
      )
    ) {
      setModelKey("");
      setThinking(false);
      storeModelPreference(conversationId, "", false);
      setBuddyNote("原先选择的模型已移除，已切换为当前默认模型。");
    }
  }, [modelKey, settings.providers, conversationId]);
  const scroller = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const dropTarget = useRef<HTMLDivElement>(null);
  const previewTarget = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const imagesRef = useRef(images);
  draftRef.current = draft;
  imagesRef.current = images;
  useEffect(() => {
    const discard = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== conversationId) return;
      draftRef.current = "";
      imagesRef.current = [];
      setDraft("");
      setImages([]);
    };
    window.addEventListener("bai-conversation-deleted", discard);
    return () =>
      window.removeEventListener("bai-conversation-deleted", discard);
  }, [conversationId]);
  const persistDraft = useCallback(
    (text = draftRef.current, attachments = imagesRef.current) => {
      storeChatDraft(conversationId, { text, images: attachments });
    },
    [conversationId],
  );
  useEffect(
    () => () => {
      // Navigating to another page must not discard a half-written message.
      if (draftRef.current || imagesRef.current.length)
        storeChatDraft(conversationId, {
          text: draftRef.current,
          images: imagesRef.current,
        });
    },
    [conversationId],
  );
  function changeDraft(value: string) {
    draftRef.current = value;
    setDraft(value);
    persistDraft(value, imagesRef.current);
  }
  function changeImages(values: Attachment[]) {
    imagesRef.current = values;
    setImages(values);
    persistDraft(draftRef.current, values);
  }
  function focusComposer(note = "我在，想到什么就继续说吧。") {
    setBuddyNote(note);
    requestAnimationFrame(() => {
      composer.current?.focus({ preventScroll: true });
      composer.current?.setSelectionRange(
        composer.current.value.length,
        composer.current.value.length,
      );
    });
  }
  useEffect(() => {
    if (!buddyNote) return;
    const timer = window.setTimeout(() => setBuddyNote(""), 3600);
    return () => window.clearTimeout(timer);
  }, [buddyNote]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = composer.current;
      if (!input || input.disabled) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationId]);
  useLayoutEffect(() => {
    if (composer.current) resizeMessageInput(composer.current);
  }, [draft]);
  useEffect(() => {
    const input = composer.current;
    if (!input || typeof ResizeObserver === "undefined") return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resizeMessageInput(input);
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, []);
  const currentId = useRef(conversationId);
  currentId.current = conversationId;
  const messageRequest = useRef(0);
  const loadMessages = useCallback(async (id: string) => {
    const request = ++messageRequest.current;
    const values = await api<Message[]>(`/conversations/${id}/messages`);
    if (
      mounted.current &&
      currentId.current === id &&
      request === messageRequest.current
    ) {
      setMessages(values);
      return true;
    }
    return false;
  }, []);
  const track = useCallback(
    async (value: Run, id: string) => {
      if (!mounted.current || currentId.current !== id) return;
      controller.current?.abort();
      const watch = new AbortController();
      controller.current = watch;
      setRun(value);
      setBusy(true);
      setStream("");
      setReasoning("");
      setContextStatus("");
      let reasoningStep = "";
      setTools([]);
      setImageGeneration(null);
      try {
        const result = await readEvents(
          value.id,
          (event) => {
            if (watch.signal.aborted) return;
            if (event.kind === "task") {
              updateTask(event.data as unknown as ComplexTask);
              setRun((current) =>
                current?.id === value.id
                  ? { ...current, task_id: String(event.data.id) }
                  : current,
              );
            }
            if (event.kind === "delta")
              setStream((text) => text + String(event.data.text || ""));
            if (event.kind === "answer")
              setStream(String(event.data.text || ""));
            if (event.kind === "reasoning") {
              const step = String(event.data.step || "");
              const separator =
                reasoningStep && step !== reasoningStep ? "\n\n" : "";
              reasoningStep = step;
              setReasoning(
                (text) => text + separator + String(event.data.text || ""),
              );
            }
            if (event.kind === "context")
              setContextStatus(
                event.data.status === "compacting"
                  ? "正在整理上下文…"
                  : event.data.status === "degraded"
                    ? String(event.data.text)
                    : "",
              );
            if (event.kind === "tool") setTools((values) => [...values, event]);
            if (event.kind === "image_generation") {
              const status = String(event.data.status || "");
              const stage = String(event.data.stage || "generate");
              const startedAt = Number(event.data.started_at) * 1000;
              if (status === "started" || status === "progress") {
                setImageGeneration((current) => ({
                  status,
                  stage,
                  startedAt:
                    Number.isFinite(startedAt) && startedAt > 0
                      ? startedAt
                      : current?.startedAt || Date.now(),
                }));
              }
              if (status === "finished") {
                const result = event.data.result;
                const output =
                  result && typeof result === "object"
                    ? (result as Record<string, unknown>)
                    : {};
                const hasImage =
                  Array.isArray(output.artifacts) &&
                  output.artifacts.some(
                    (artifact: unknown) =>
                      artifact !== null &&
                      typeof artifact === "object" &&
                      "id" in artifact &&
                      typeof artifact.id === "string" &&
                      "media_type" in artifact &&
                      typeof artifact.media_type === "string" &&
                      artifact.media_type.startsWith("image/"),
                  );
                const elapsedMs = Number(event.data.elapsed_ms);
                setImageGeneration((current) => ({
                  status: "finished",
                  stage,
                  startedAt:
                    Number.isFinite(startedAt) && startedAt > 0
                      ? startedAt
                      : current?.startedAt || Date.now(),
                  elapsedSeconds:
                    Number.isFinite(elapsedMs) && elapsedMs >= 0
                      ? Math.floor(elapsedMs / 1000)
                      : undefined,
                  error: !hasImage
                    ? typeof output.error === "string"
                      ? output.error
                      : "尚未取得可展示的图片产物"
                    : undefined,
                }));
              }
            }
            if (event.kind === "memory") {
              receiveMemory(event);
              void refresh().catch(() => {});
            }
          },
          watch.signal,
        );
        if (watch.signal.aborted) return;
        setRun(result);
        if (result.status === "failed")
          setError(result.error || "本次回答未完成");
        if (result.status === "cancelled") setError("");
        let loaded = false;
        try {
          loaded = await loadMessages(id);
        } catch {
          if (!watch.signal.aborted)
            setSyncWarning("回答状态已保存，聊天记录暂未刷新，请重试刷新。");
        }
        if (watch.signal.aborted) return;
        if (loaded) setStream("");
        if (result.status === "completed") setReasoning("");
        setBusy(false);
        void refresh().catch(() => {
          if (!watch.signal.aborted)
            setSyncWarning("回答已结束，部分列表暂未刷新，请重试刷新。");
        });
      } catch (error) {
        if (!watch.signal.aborted) {
          setError((error as Error).message);
          setBusy(false);
        }
      }
    },
    [loadMessages, refresh, receiveMemory, updateTask],
  );
  useEffect(() => {
    let live = true;
    const saved = readChatDraft(conversationId);
    draftRef.current = saved?.text || "";
    imagesRef.current = saved?.images || [];
    setDraft(saved?.text || "");
    setImages(saved?.images || []);
    setMessages([]);
    setStream("");
    setReasoning("");
    setContextStatus("");
    setUploading(false);
    setTools([]);
    setImageGeneration(null);
    setMemoryNotice(null);
    setError("");
    setSyncWarning("");
    setRun(null);
    setTasks([]);
    setSubmitting(false);
    setStopping(false);
    actionLock.current = false;
    actionSequence.current += 1;
    setBusy(false);
    setEditingMessageId("");
    setEditedText("");
    setActiveTurn("");
    followLatest.current = true;
    setAtLatest(true);
    if (conversationId) {
      api<ComplexTask[]>(`/conversations/${conversationId}/tasks`)
        .then((items) => {
          if (live)
            setTasks((current) => [
              ...current,
              ...items.filter(
                (item) => !current.some((value) => value.id === item.id),
              ),
            ]);
        })
        .catch((error: Error) => {
          if (live) setError(error.message);
        });
      const initialMessages = loadMessages(conversationId);
      void initialMessages.catch((error: Error) => {
        if (live) setError(error.message);
      });
      api<Run[]>(`/runs?conversation_id=${conversationId}`)
        .then(async (values) => {
          // Finish the initial snapshot before a later reload can replace it.
          await initialMessages.catch(() => {});
          if (!live) return;
          const active = values.find((value) =>
            ["queued", "running"].includes(value.status),
          );
          if (active) void track(active, conversationId);
          else if (values[0]) {
            setRun(values[0]);
            // A fast run can finish between the first message load and this request.
            // Restore the persisted answer and tool results, including fast runs.
            await loadMessages(conversationId).catch(() => {
              if (live)
                setSyncWarning(
                  "运行状态已恢复，聊天记录暂未刷新，请重试刷新。",
                );
            });
            if (!live) return;
            const history = await api<RunEvent[]>(
              `/runs/${values[0].id}/tools`,
            ).catch(() => {
              if (live)
                setSyncWarning("聊天已恢复，工具记录暂未读取，请稍后再试。");
              return [];
            });
            if (!live) return;
            setTools(history.filter((event) => event.kind === "tool"));
            if (values[0].status !== "completed") {
              const steps = new Map<string, string>();
              history
                .filter((event) => event.kind === "reasoning")
                .forEach((event) => {
                  const key = String(event.data.step || "");
                  steps.set(
                    key,
                    (steps.get(key) || "") + String(event.data.text || ""),
                  );
                });
              setReasoning([...steps.values()].join("\n\n"));
            }
            const contextEvent = history
              .filter((event) => event.kind === "context")
              .at(-1);
            if (contextEvent?.data.status === "degraded")
              setContextStatus(String(contextEvent.data.text));
            if (Date.now() - Date.parse(values[0].created_at) < 60000) {
              history
                .filter((event) => event.kind === "memory")
                .forEach(receiveMemory);
            }
            setRun(values[0]);
            void refresh().catch(() => {
              if (live)
                setSyncWarning("聊天已恢复，部分列表暂未刷新，请重试刷新。");
            });
            if (
              values[0].status === "failed" &&
              !isRunErrorDismissed(values[0].id)
            )
              setError(values[0].error || "之前的回答未完成");
            if (values[0].status === "cancelled") setError("");
          }
        })
        .catch((error) => {
          if (live) setError(error.message);
        });
    }
    return () => {
      live = false;
      controller.current?.abort();
    };
  }, [conversationId, loadMessages, refresh, track, receiveMemory]);
  const candidates =
    memories?.filter(
      (value) =>
        value.state === "candidate" &&
        value.source_conversation_id === conversationId,
    ) || [];
  const empty = !messages.length && !busy && !stream && !reasoning && !run;
  useLayoutEffect(() => {
    const container = scroller.current;
    if (container && followLatest.current) {
      container.scrollTop = container.scrollHeight;
      setAtLatest(true);
    }
  }, [messages, stream, reasoning, busy, conversationId, tasks]);
  useEffect(() => {
    const target = thread.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const container = scroller.current;
      if (container && followLatest.current)
        container.scrollTop = container.scrollHeight;
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [conversationId, empty]);
  async function send(edited?: Pick<Message, "content" | "attachment_ids">) {
    const text = edited ? edited.content : draft;
    const attachmentIds = edited
      ? edited.attachment_ids
      : images.map((x) => x.id);
    const supplement = busy && Boolean(run?.task_id);
    if (
      actionLock.current ||
      (busy && !run) ||
      uploading ||
      (!text.trim() && !attachmentIds.length)
    )
      return false;
    actionLock.current = true;
    const sendingTo = conversationId;
    const sequence = actionSequence.current;
    const isCurrent = () =>
      mounted.current &&
      currentId.current === sendingTo &&
      actionSequence.current === sequence;
    setSubmitting(true);
    setError("");
    if (!supplement) setBusy(true);
    followLatest.current = true;
    setAtLatest(true);
    let cancelledPrevious = false;
    try {
      if (busy && run && !supplement) {
        await api<Run>(`/runs/${run.id}/cancel`, "POST");
        if (!isCurrent()) return false;
        cancelledPrevious = true;
        controller.current?.abort();
        setRun(null);
        setBusy(true);
      }
      let id = conversationId;
      const created = !id;
      if (!id) {
        const value = await api<Conversation>("/conversations", "POST", {
          title: "新对话",
          project_id: projectId,
        });
        id = value.id;
      }
      const value = await api<Run>(`/conversations/${id}/messages`, "POST", {
        content: text.trim() || "请根据上传的附件帮助我分析。",
        attachment_ids: attachmentIds,
        model_selection: selected
          ? {
              provider_id: selected.profile.id,
              model_name: selected.model.name,
              thinking_enabled: thinkingEnabled,
            }
          : undefined,
      });
      if (created) storeModelPreference(id, selected?.key || "", thinking);
      if (!isCurrent()) {
        if (!edited) clearChatDraft(sendingTo);
        void refresh().catch(() => {});
        return true;
      }
      if (!edited) {
        setDraft("");
        setImages([]);
        imagesRef.current = [];
        draftRef.current = "";
        clearChatDraft(conversationId);
        if (created) clearChatDraft(null);
        setAttachmentBatch((value) => value + 1);
      } else {
        setEditingMessageId("");
        setEditedText("");
      }
      if (created) {
        // The conversation effect owns resuming a new conversation's run.
        onConversation(id);
      } else if (currentId.current === id) {
        if (!supplement || value.id !== run?.id) void track(value, id);
        else setBuddyNote("已收到，当前步骤结束后处理补充要求。");
        void loadMessages(id).catch(() => {
          if (isCurrent())
            setSyncWarning("消息已发送，聊天记录暂未刷新，请重试刷新。");
        });
      }
      // The accepted run owns the reply immediately; list refresh cannot turn
      // an accepted submission into a failed send or discard its identity.
      void refresh().catch(() => {
        if (mounted.current && (currentId.current === id || isCurrent()))
          setSyncWarning("消息已发送，部分列表暂未刷新，请重试刷新。");
      });
      return true;
    } catch (error) {
      if (isCurrent()) {
        setError((error as Error).message);
        if (!supplement) setBusy(busy && !cancelledPrevious);
      }
      return false;
    } finally {
      if (actionSequence.current === sequence) {
        actionLock.current = false;
        setSubmitting(false);
      }
    }
  }
  async function stop() {
    if (!run || actionLock.current) return;
    actionLock.current = true;
    const stoppingIn = conversationId;
    const sequence = actionSequence.current;
    const isCurrent = () =>
      mounted.current &&
      currentId.current === stoppingIn &&
      actionSequence.current === sequence;
    setStopping(true);
    try {
      const stopped = await api<Run>(`/runs/${run.id}/cancel`, "POST");
      if (isCurrent()) {
        setRun(stopped);
        await loadMessages(stoppingIn!).catch(() => {
          if (isCurrent())
            setSyncWarning("已停止生成，保存的回答暂未刷新，请重试刷新。");
        });
        if (!isCurrent()) return;
        setBusy(false);
      }
    } catch (error) {
      if (isCurrent()) setError((error as Error).message);
    } finally {
      if (actionSequence.current === sequence) {
        actionLock.current = false;
        setStopping(false);
      }
    }
  }
  async function retry(sourceRunId = run?.id, taskId?: string) {
    if (!conversationId || actionLock.current || busy || !modelReady) return;
    const id = conversationId;
    const sequence = actionSequence.current;
    const isCurrent = () =>
      mounted.current &&
      currentId.current === id &&
      actionSequence.current === sequence;
    actionLock.current = true;
    setSubmitting(true);
    setError("");
    try {
      const value = await api<Run>(
        taskId ? `/tasks/${taskId}/resume` : `/conversations/${id}/retry`,
        "POST",
        {
          source_run_id: sourceRunId,
          model_selection: selected
            ? {
                provider_id: selected.profile.id,
                model_name: selected.model.name,
                thinking_enabled: thinkingEnabled,
              }
            : undefined,
        },
      );
      if (!isCurrent()) return;
      void track(value, id);
    } catch (error) {
      if (isCurrent()) setError((error as Error).message);
      if (isCurrent()) void refreshChatView();
    } finally {
      if (isCurrent()) {
        actionLock.current = false;
        setSubmitting(false);
      }
    }
  }
  async function refreshChatView() {
    const id = conversationId;
    const sequence = actionSequence.current;
    const isCurrent = () =>
      mounted.current &&
      currentId.current === id &&
      actionSequence.current === sequence;
    try {
      await Promise.all([id ? loadMessages(id) : Promise.resolve(), refresh()]);
      if (isCurrent()) setSyncWarning("");
    } catch {
      if (isCurrent())
        setSyncWarning(
          "暂时无法刷新，消息和运行记录仍保存在本机，请稍后再试。",
        );
    }
  }
  function closeError() {
    if (run?.status === "failed") {
      try {
        sessionStorage.setItem(`bai-dismissed-chat-error:${run.id}`, "1");
      } catch {
        // Closing the current notice still works when session storage is unavailable.
      }
    }
    setError("");
    composer.current?.focus({ preventScroll: true });
  }
  const lastAssistant = messages
    .filter((value) => value.role === "assistant")
    .at(-1);
  const incompleteRun =
    !busy && run && !run.task_id && ["failed", "cancelled"].includes(run.status)
      ? run
      : null;
  const incompleteAssistant = incompleteRun
    ? messages.find(
        (value) =>
          value.role === "assistant" && value.run_id === incompleteRun.id,
      )
    : undefined;
  const orphanReasoning =
    !busy &&
    !run?.task_id &&
    Boolean(reasoning) &&
    !messages.some(
      (value) => value.role === "assistant" && value.run_id === run?.id,
    );
  const showIncompleteReply =
    Boolean(incompleteRun && !incompleteAssistant) ||
    orphanReasoning ||
    (!busy &&
      !run?.task_id &&
      Boolean(stream) &&
      !messages.some(
        (message) => message.run_id === run?.id && message.role === "assistant",
      ));
  const baseTurns = useMemo(() => {
    const turns: (Message & { answer: string })[] = [];
    for (const message of messages) {
      if (message.role === "user") turns.push({ ...message, answer: "" });
      else if (message.role === "assistant" && turns.length) {
        const turn = turns[turns.length - 1];
        turn.answer += (turn.answer ? "\n" : "") + message.content;
      }
    }
    return turns;
  }, [messages]);
  const turns = useMemo(() => {
    if (!busy || !stream || !baseTurns.length) return baseTurns;
    const last = baseTurns[baseTurns.length - 1];
    return [
      ...baseTurns.slice(0, -1),
      { ...last, answer: last.answer + (last.answer ? "\n" : "") + stream },
    ];
  }, [baseTurns, busy, stream]);
  const entries = useMemo(() => {
    const tasksByMessage = new Map<string, ComplexTask[]>();
    const pendingTasks = new Map<string, ComplexTask[]>();
    const replies = new Map(
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => [message.run_id, message]),
    );
    for (const task of [...tasks].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    )) {
      const reply = task.source_run_id
        ? replies.get(task.source_run_id)
        : undefined;
      const target = reply ? tasksByMessage : pendingTasks;
      const key = reply?.id || task.source_message_id;
      const anchored = target.get(key) || [];
      anchored.push(task);
      target.set(key, anchored);
    }
    return messages.flatMap((message) => [
      {
        message,
        cards: tasksByMessage.get(message.id) || [],
        synthetic: false,
      },
      ...(pendingTasks.get(message.id) || []).map((task) => ({
        message: {
          ...message,
          id: `task-reply-${task.id}`,
          role: "assistant",
          content: "",
          attachment_ids: [],
          run_id: task.source_run_id || null,
          reasoning: "",
        } as Message,
        cards: [task],
        synthetic: true,
      })),
    ]);
  }, [messages, tasks]);
  const inlineActivity =
    busy &&
    entries.some(
      (entry) =>
        entry.synthetic &&
        entry.cards.some(
          (task) => task.id === run?.task_id && task.source_run_id === run?.id,
        ),
    );
  const hasDraft = Boolean(draft.trim() || images.length);
  const showStop = busy && !hasDraft;
  return (
    <div className="chat-layout" ref={dropTarget}>
      <div className={`chat-main ${empty ? "is-empty" : ""}`}>
        <div
          className={`chat-scroll ${empty ? "is-empty" : ""}`}
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            if (scrollFrame.current) return;
            scrollFrame.current = requestAnimationFrame(() => {
              scrollFrame.current = 0;
              if (!element.isConnected) return;
              const latest =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                36;
              if (latest) followLatest.current = true;
              setAtLatest(latest);
              const boundary = element.getBoundingClientRect().top + 80;
              let current = turns[0]?.id || "";
              for (let index = turns.length - 1; index >= 0; index--) {
                const target = turnElements.current.get(turns[index].id);
                if (target && target.getBoundingClientRect().top <= boundary) {
                  current = turns[index].id;
                  break;
                }
              }
              setActiveTurn(current);
            });
          }}
          onWheel={(event) => {
            if (event.deltaY < 0) {
              followLatest.current = false;
              setAtLatest(false);
            }
          }}
          onTouchMove={() => {
            followLatest.current = false;
          }}
          onPointerDown={(event) => {
            if (
              event.clientX >=
              event.currentTarget.getBoundingClientRect().right - 16
            )
              followLatest.current = false;
          }}
          onKeyDown={(event) => {
            if (["ArrowUp", "PageUp", "Home"].includes(event.key))
              followLatest.current = false;
            if (event.key === "End") followLatest.current = true;
          }}
        >
          {empty ? (
            <div className="welcome">
              <div>
                <p className="welcome-date">
                  {new Intl.DateTimeFormat("zh-CN", {
                    month: "long",
                    day: "numeric",
                    weekday: "long",
                    timeZone: "Asia/Shanghai",
                  }).format(new Date())}
                </p>
                <h1>今天想做点什么？</h1>
              </div>
            </div>
          ) : (
            <div className="message-list" ref={thread}>
              {entries.map(({ message: value, cards, synthetic }) => (
                <article
                  key={cards.length ? `task-reply-${cards[0].id}` : value.id}
                  id={`chat-message-${value.id}`}
                  tabIndex={-1}
                  className={`message ${value.role}`}
                  ref={(element) => {
                    if (value.role !== "user") return;
                    if (element) turnElements.current.set(value.id, element);
                    else turnElements.current.delete(value.id);
                  }}
                >
                  {value.role !== "assistant" && (
                    <div className="message-avatar">
                      <span>我</span>
                    </div>
                  )}
                  {value.role === "assistant" && (
                    <div className="message-avatar assistant-avatar">
                      <BaiAvatar
                        interactive
                        motion={
                          synthetic && busy && value.run_id === run?.id
                            ? "thinking"
                            : "still"
                        }
                        label="和XiaoXi打个招呼，继续聊天"
                        onClick={() =>
                          focusComposer("我在呢。想追问什么，直接告诉我就好。")
                        }
                      />
                    </div>
                  )}
                  <div className="message-body">
                    <span className="message-name">
                      {value.role === "assistant" ? "XiaoXi" : "你"}
                    </span>
                    {synthetic && busy && value.run_id === run?.id ? (
                      <ReplyActivity
                        reasoning={reasoning}
                        stream={stream}
                        imageGeneration={imageGeneration}
                        contextStatus={contextStatus}
                        toolCount={tools.length}
                        runId={run?.id}
                      />
                    ) : (
                      value.role === "assistant" && (
                        <Reasoning text={value.reasoning || ""} />
                      )
                    )}
                    {cards.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        busy={busy}
                        running={busy && run?.task_id === task.id}
                        onUpdate={updateTask}
                        onResume={(taskId) => void retry(undefined, taskId)}
                      />
                    ))}
                    {value.role === "user" && editingMessageId === value.id ? (
                      <div className="user-message-editor">
                        <Textarea
                          aria-label="修改消息内容"
                          value={editedText}
                          disabled={busy}
                          autoFocus
                          onChange={(event) =>
                            setEditedText(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape" && !busy)
                              setEditingMessageId("");
                          }}
                        />
                        <p className="user-message-editor-hint">
                          保留原消息和附件，修改后作为新消息发送。
                        </p>
                        <div className="user-message-editor-actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setEditingMessageId("")}
                          >
                            取消
                          </Button>
                          <Button
                            size="sm"
                            disabled={
                              busy ||
                              uploading ||
                              !modelReady ||
                              (!editedText.trim() &&
                                !value.attachment_ids.length)
                            }
                            onClick={() =>
                              void send({
                                content: editedText,
                                attachment_ids: value.attachment_ids,
                              })
                            }
                          >
                            发送修改
                          </Button>
                        </div>
                      </div>
                    ) : (
                      !synthetic && (
                        <Markdown
                          runId={
                            value.role === "assistant"
                              ? value.run_id || undefined
                              : undefined
                          }
                        >
                          {value.content}
                        </Markdown>
                      )
                    )}
                    {value.role === "assistant" && !synthetic && (
                      <AnswerPresentation
                        runId={value.run_id || undefined}
                        status={
                          value.run_id === run?.id
                            ? run?.status
                            : value.run_status || "completed"
                        }
                        content={value.content}
                      />
                    )}
                    {value.role === "assistant" && !synthetic && (
                      <AnswerActions
                        content={value.content}
                        runId={
                          value.run_id ||
                          (value === lastAssistant &&
                          run?.status === "completed"
                            ? run.id
                            : undefined)
                        }
                        runStatus={
                          value.run_id === run?.id || value === lastAssistant
                            ? run?.status
                            : value.run_status || "completed"
                        }
                        tools={
                          value === lastAssistant && run?.status === "completed"
                            ? tools
                            : undefined
                        }
                      />
                    )}
                    {value.role === "assistant" &&
                      !synthetic &&
                      !value.task_id &&
                      !cards.length &&
                      !(value.run_id === run?.id && run?.task_id) &&
                      ["failed", "cancelled"].includes(
                        value.run_status ||
                          (value.run_id === run?.id ? run?.status || "" : ""),
                      ) && (
                        <IncompleteReplyNotice
                          cancelled={
                            (value.run_status || run?.status) === "cancelled"
                          }
                          onRetry={
                            value === lastAssistant &&
                            value.run_id === run?.id &&
                            run?.retry_action !== "none"
                              ? () => void retry(value.run_id || undefined)
                              : undefined
                          }
                          disabled={busy || submitting || !modelReady}
                        />
                      )}

                    {value.attachment_ids.length > 0 && (
                      <div className="message-pictures">
                        {value.attachment_ids.map((id) => (
                          <MessageAttachment id={id} key={id} />
                        ))}
                      </div>
                    )}
                    {value.role === "user" && editingMessageId !== value.id && (
                      <UserMessageActions
                        content={value.content}
                        disabled={busy || uploading}
                        onEdit={() => {
                          setEditingMessageId(value.id);
                          setEditedText(value.content);
                        }}
                      />
                    )}
                  </div>
                </article>
              ))}
              {busy && !inlineActivity && (
                <article className="message assistant">
                  <div className="message-avatar assistant-avatar">
                    <BaiAvatar
                      interactive
                      motion="thinking"
                      label="XiaoXi正在思考，点我继续聊天"
                      onClick={() => focusComposer("别急，我还在整理思路。")}
                    />
                  </div>
                  <div className="message-body">
                    <span className="message-name">XiaoXi</span>
                    <ReplyActivity
                      reasoning={reasoning}
                      stream={stream}
                      imageGeneration={imageGeneration}
                      contextStatus={contextStatus}
                      toolCount={tools.length}
                      runId={run?.id}
                    />
                  </div>
                </article>
              )}
              {showIncompleteReply && (
                <article className="message assistant incomplete-reply">
                  <div className="message-avatar assistant-avatar">
                    <BaiAvatar
                      interactive
                      motion="still"
                      label="和XiaoXi打个招呼，继续聊天"
                      onClick={() =>
                        focusComposer("没关系，想继续聊什么都可以。")
                      }
                    />
                  </div>
                  <div className="message-body">
                    <span className="message-name">XiaoXi</span>
                    {reasoning && <Reasoning text={reasoning} incomplete />}
                    {stream && <Markdown runId={run?.id}>{stream}</Markdown>}
                    {stream && !incompleteRun && (
                      <p role="status">记录暂未同步，已显示内容保留在这里。</p>
                    )}
                    {incompleteRun && (
                      <IncompleteReplyNotice
                        cancelled={incompleteRun.status === "cancelled"}
                        onRetry={
                          run?.retry_action === "none"
                            ? undefined
                            : () => void retry()
                        }
                        disabled={submitting || !modelReady}
                      />
                    )}
                    {(incompleteRun || stream) && (
                      <AnswerActions
                        content={stream}
                        runId={incompleteRun?.id || run?.id}
                        runStatus={incompleteRun?.status || run?.status}
                        tools={tools}
                      />
                    )}
                  </div>
                </article>
              )}
            </div>
          )}
          {candidates.length > 0 && (
            <section className="chat-memory-reviews" aria-label="记忆确认">
              {candidates.map((memory) => (
                <MemoryReview
                  key={memory.id}
                  memory={memory}
                  refresh={refresh}
                />
              ))}
            </section>
          )}
        </div>
        {turns.length > 0 && (
          <Tooltip.Provider
            delayDuration={120}
            skipDelayDuration={100}
            disableHoverableContent
          >
            <nav className="chat-turn-nav" aria-label="对话定位">
              {turns.map((turn, index) => {
                const label = `第 ${index + 1} 轮：${turn.content.trim() || "图片消息"}`;
                return (
                  <Tooltip.Root key={turn.id}>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        aria-label={label}
                        aria-current={
                          activeTurn === turn.id ? "step" : undefined
                        }
                        onClick={() => {
                          const container = scroller.current;
                          const target = turnElements.current.get(turn.id);
                          if (!container || !target) return;
                          followLatest.current = false;
                          setAtLatest(false);
                          setActiveTurn(turn.id);
                          container.scrollTo({
                            top:
                              container.scrollTop +
                              target.getBoundingClientRect().top -
                              container.getBoundingClientRect().top -
                              24,
                            behavior: "instant",
                          });
                        }}
                      />
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        className="chat-turn-preview"
                        side="left"
                        sideOffset={12}
                        collisionPadding={16}
                      >
                        <strong>{turn.content.trim() || "图片消息"}</strong>
                        <p>{turn.answer.trim() || "尚无回答"}</p>
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                );
              })}
            </nav>
          </Tooltip.Provider>
        )}
        <div className="composer-area">
          {!empty && !atLatest && (
            <button
              className="chat-jump-latest"
              onClick={() => {
                followLatest.current = true;
                setAtLatest(true);
                scroller.current?.scrollTo({
                  top: scroller.current.scrollHeight,
                  behavior: "smooth",
                });
              }}
            >
              <ArrowDown size={14} />
              回到最新
            </button>
          )}
          {buddyNote && (
            <div className="chat-buddy-note" role="status" aria-live="polite">
              <span className="chat-buddy-note-avatar">
                <BaiAvatar motion="still" />
              </span>
              <span>{buddyNote}</span>
            </div>
          )}
          {memoryNotice && (
            <MemorySavedNotice
              key={memoryNotice.change_id}
              notice={memoryNotice}
              refresh={refresh}
              onClose={closeMemoryNotice}
            />
          )}
          {error && (
            <ErrorNotice
              message={
                run?.kind === "chat" &&
                error === "接口认证失败，请检查密钥与接口地址。"
                  ? "聊天模型认证或权限检查失败，请在「模型连接」检查密钥与接口地址。"
                  : error
              }
              retry={
                run?.status === "failed" && run?.retry_action !== "none"
                  ? () => void retry()
                  : undefined
              }
              onClose={closeError}
              action={
                /密钥|接口|认证|模型|连接|配置|401|403|unauthorized/i.test(
                  error,
                )
                  ? { label: "配置接口", onClick: () => onAction("settings") }
                  : undefined
              }
            />
          )}
          {syncWarning && (
            <ErrorNotice
              message={syncWarning}
              onClose={() => setSyncWarning("")}
              retry={() => void refreshChatView()}
            />
          )}
          {contextStatus && contextStatus !== "正在整理上下文…" && (
            <p className="context-status" role="status">
              {contextStatus}
            </p>
          )}
          {!modelReady && (
            <button
              className="setup-nudge"
              onClick={() => onAction("settings")}
            >
              <Cable size={16} />
              <span>先连接你的模型，就能开始对话和学习。</span>
              <ArrowRight size={15} />
            </button>
          )}
          <div className="composer">
            <div className="composer-attachments" ref={previewTarget} />
            <Textarea
              id="chat-message"
              ref={composer}
              aria-label="发送给XiaoXi的消息"
              value={draft}
              onChange={(e) => changeDraft(e.target.value)}
              placeholder={
                busy && run?.task_id
                  ? "补充当前任务要求…"
                  : modelReady
                    ? "输入消息…"
                    : "连接模型后开始对话"
              }
              rows={2}
              disabled={submitting || stopping}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  if (modelReady) void send();
                }
              }}
            />
            <div className="composer-bottom">
              <div className="composer-tools">
                <ImagesInput
                  allowFiles
                  dropTarget={dropTarget}
                  previewTarget={previewTarget}
                  scopeKey={`${conversationId || "new"}:${attachmentBatch}`}
                  images={images}
                  onChange={changeImages}
                  disabled={submitting || stopping || !modelReady}
                  onError={setError}
                  onUploading={setUploading}
                />
                <ToolboxMenu
                  open={composerMenu === "mcp"}
                  onOpenChange={(open) => changeComposerMenu("mcp", open)}
                  onSettings={() => {
                    setComposerMenu(null);
                    onAction("tools");
                  }}
                />
                <SkillsMenu
                  open={composerMenu === "skills"}
                  onOpenChange={(open) => changeComposerMenu("skills", open)}
                  onSettings={() => {
                    setComposerMenu(null);
                    onAction("skills");
                  }}
                />
                <Hint
                  label={
                    thinkingControl === "none"
                      ? "此模型未配置思考开关"
                      : thinkingControl === "always"
                        ? "此模型始终开启思考"
                        : thinkingEnabled
                          ? "关闭思考模式"
                          : "开启思考模式"
                  }
                >
                  <button
                    className="composer-thinking"
                    aria-label="思考模式"
                    aria-pressed={thinkingEnabled}
                    disabled={
                      busy ||
                      thinkingControl === "none" ||
                      thinkingControl === "always"
                    }
                    onClick={() => {
                      setThinking(!thinking);
                      storeModelPreference(
                        conversationId,
                        selected?.key || "",
                        !thinking,
                      );
                    }}
                  >
                    <Sparkles size={15} aria-hidden="true" />
                    <span>
                      {thinkingControl === "always" ? "始终思考" : "思考"}
                    </span>
                  </button>
                </Hint>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="composer-model"
                      aria-label="选择模型"
                      disabled={busy}
                    >
                      <span>{selected?.model.name || "选择模型"}</span>
                      <ChevronDown size={13} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="model-menu"
                      align="start"
                      sideOffset={8}
                      collisionPadding={16}
                    >
                      <DropdownMenu.Label className="model-menu-label">
                        模型
                      </DropdownMenu.Label>
                      {choices
                        .filter((x) => x.profile.key_configured)
                        .map((choice) => (
                          <DropdownMenu.Item
                            key={choice.key}
                            className="model-menu-item model-choice"
                            onSelect={() => {
                              setModelKey(choice.key);
                              setThinking(false);
                              storeModelPreference(
                                conversationId,
                                choice.key,
                                false,
                              );
                            }}
                          >
                            <span>
                              <strong>{choice.model.name}</strong>
                              <small>
                                {choice.profile.label}
                                {choice.profile.id ===
                                  settings.default_provider &&
                                choice.model.name ===
                                  choice.profile.default_model
                                  ? " · 默认"
                                  : ""}
                              </small>
                            </span>
                            {selected?.key === choice.key && (
                              <Check size={15} />
                            )}
                          </DropdownMenu.Item>
                        ))}
                      {!choices.some((x) => x.profile.key_configured) && (
                        <div className="model-menu-current">尚未连接模型</div>
                      )}
                      <DropdownMenu.Separator className="model-menu-separator" />
                      <DropdownMenu.Item
                        className="model-menu-item"
                        onSelect={() => onAction("settings")}
                      >
                        <Settings2 size={15} />
                        连接与设置
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
              <div className="composer-submit">
                <Button
                  aria-label={showStop ? "停止生成" : "发送消息"}
                  size="icon"
                  disabled={
                    submitting ||
                    stopping ||
                    (showStop ? !run : uploading || !modelReady || !hasDraft)
                  }
                  onClick={() => {
                    if (showStop) void stop();
                    else void send();
                  }}
                >
                  {showStop ? <Square size={15} /> : <ArrowUp size={19} />}
                </Button>
              </div>
            </div>
          </div>
        </div>
        {empty && !conversationId && (
          <ChatHome
            conversations={conversations}
            goals={goals}
            timezone={settings.timezone}
            onConversation={onConversation}
            onAction={onAction}
            onPlan={onPlan}
            onPrompt={(text) => {
              changeDraft(
                draftRef.current.trim()
                  ? `${text.trimEnd()}\n\n${draftRef.current}`
                  : text,
              );
              requestAnimationFrame(() => {
                const input = composer.current;
                input?.focus();
                input?.setSelectionRange(
                  input.value.length,
                  input.value.length,
                );
              });
            }}
          />
        )}
      </div>
    </div>
  );
}
