import { SoftSelect } from "./ui/soft-select";
import { resizeMessageInput } from "@/lib/composerSize";
import { ContextMeter, type ContextUsage } from "./ContextMeter";
import { ComposerModelPicker } from "./ComposerModelPicker";
import {
  chatModelKey,
  readModelPreference,
  storeModelPreference,
  type ModelOptions,
} from "@/lib/chatModelPreferences";
import { isSendShortcut } from "@/lib/generalPreferences";
import { useComposerPlaceholder } from "@/lib/useComposerPlaceholder";
import { useSpeechInput } from "@/lib/useSpeechInput";
import { SpeechInputButton } from "./SpeechInputButton";
import { useDesktopTaskRead } from "@/lib/useDesktopTaskRead";
import { isTauri } from "@tauri-apps/api/core";
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
  ArrowRight,
  ArrowUp,
  Cable,
  Check,
  ChevronDown,
  Image as ImageIcon,
  ImagePlus,
  Folder,
  Library,
  Pin,
  Plus,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  readEvents,
  type Conversation,
  type Project,
  type Message,
  type Run,
  type RunEvent,
  type Settings,
  type Attachment,
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
import { useAvatarActivity } from "@/lib/useAvatarActivity";
import { NewChatStarters, NewChatWelcome } from "./NewChatWelcome";
import { ChatScrollNavigation } from "./ChatScrollNavigation";
import { TaskCard } from "./TaskCard";
import { LearningHandoffCards } from "./LearningHandoffCards";
import { CourseOutline, LearningCourseCards, type CourseReceipt } from "./LearningCourseCards";
import {
  MemoryReview,
  MemorySavedNotice,
  type MemoryNotice,
} from "./MemoryFeedback";
import { errorMessage } from "@/lib/utils";

const configurationProblem = /密钥|接口|认证|模型|连接|配置|401|403|unauthorized/i;

function IncompleteReplyNotice({
  cancelled,
  reason,
  onRetry,
  onSettings,
  disabled,
}: {
  cancelled: boolean;
  reason?: string | null;
  onRetry?: () => void;
  onSettings?: () => void;
  disabled?: boolean;
}) {
  const showSettings = Boolean(onSettings && reason && configurationProblem.test(reason));
  // Title, then what happened, then what is kept; the action sits on its own row.
  return (
    <div
      className={`incomplete-reply-notice ${cancelled ? "is-cancelled" : "is-failed"}`}
      role="status"
    >
      <header>
        <AlertCircle size={15} aria-hidden="true" />
        <strong>{cancelled ? "回答已停止" : "这次回答没有完成"}</strong>
      </header>
      {!cancelled && (
        <p className="incomplete-reply-reason">
          {reason || "模型连接中断，没有返回完整回答。"}
        </p>
      )}
      <p className="incomplete-reply-kept">
        {cancelled
          ? "已经显示的内容和完成的工具操作都会保留。"
          : "上面已显示的内容和完成的工具操作都已保留。"}
        {onRetry ? "可以重新生成，或换个说法继续。" : "可以发送新要求继续。"}
      </p>
      {(onRetry || showSettings) && (
        <div className="incomplete-reply-actions">
          {showSettings && (
            <Button size="sm" variant="ghost" onClick={onSettings}>
              检查模型连接
            </Button>
          )}
          {onRetry && (
            <Button size="sm" variant="outline" disabled={disabled} onClick={onRetry}>
              <RotateCcw size={14} aria-hidden="true" />
              重新生成
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type StoredChatDraft = {
  text: string;
  images: Attachment[];
};

const chatDraftKey = (conversationId: string | null) =>
  `bai-chat-draft:${conversationId || "new"}`;

/** 回答方式与检索开关对所有对话生效，不再按对话分别保存。 */
const chatOptionsKey = "bai-chat-options";

/** agent 可调用工具；chat 只发送系统提示词与对话，更省 token。 */
type ChatOptions = { mode: "agent" | "chat"; useMemory: boolean; useKnowledge: boolean };
const defaultChatOptions: ChatOptions = { mode: "agent", useMemory: true, useKnowledge: true };

function readChatOptions(): ChatOptions {
  try {
    const value = JSON.parse(localStorage.getItem(chatOptionsKey) || "null");
    return {
      mode: value?.mode === "chat" ? "chat" : "agent",
      useMemory: value?.useMemory !== false,
      useKnowledge: value?.useKnowledge !== false,
    };
  } catch {
    return defaultChatOptions;
  }
}

function storeChatOptions(value: ChatOptions) {
  try {
    localStorage.setItem(chatOptionsKey, JSON.stringify(value));
  } catch {
    /* Storage restrictions must not block changing the reply mode. */
  }
}

/** 删除对话时清理对应草稿与模型偏好；新建入口保留已有输入。 */
export function clearChatPreferences(conversationId: string) {
  try {
    localStorage.removeItem(chatDraftKey(conversationId));
    localStorage.removeItem(chatModelKey(conversationId));
    // 清理旧版按对话保存的回答选项。
    localStorage.removeItem(`bai-chat-options:${conversationId || "new"}`);
  } catch {
    /* Storage restrictions must not block deleting a chat. */
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

function clearChatDraft(
  conversationId: string | null,
  expected?: StoredChatDraft | null,
) {
  try {
    // A send accepted after navigation must not erase a newer unsent message.
    if (
      expected !== undefined &&
      JSON.stringify(readChatDraft(conversationId)) !== JSON.stringify(expected)
    ) return;
    localStorage.removeItem(chatDraftKey(conversationId));
  } catch {
    /* Ignore storage failures in restricted windows. */
  }
}

function ReplyActivity({
  reasoning,
  stream,
  imageGeneration,
  runId,
  progress,
}: {
  reasoning: string;
  stream: string;
  imageGeneration: ImageGenerationProgress | null;
  runId?: string;
  progress?: string;
}) {
  return (
    <>
      <Reasoning text={reasoning} active />
      {imageGeneration && <ImageGenerationPreview progress={imageGeneration} />}
      {stream && <Markdown runId={runId}>{stream}</Markdown>}
      {!imageGeneration && (
        <div className="thinking" role="status" aria-live="polite">
          <span className="thinking-label">{progress || "XiaoXi 正在思考"}</span>
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
  memories,
  refresh,
  onAction,
  onContextSettings,
  projectId = null,
  projects = [],
  pinNew = false,
  onProjectChange,
  onProjectOpen,
  onLibrary,
  focusMessageId,
  onMessageFocused,
}: {
  projectId?: string | null;
  projects?: Project[];
  pinNew?: boolean;
  onProjectChange?: (id: string | null, conversation?: Conversation) => void;
  onProjectOpen?: (id: string) => void;
  onLibrary?: (id: string) => void;
  focusMessageId?: string | null;
  onMessageFocused?: () => void;
  conversationId: string | null;
  onConversation: (id: string) => void;
  settings: Settings;
  memories?: Memory[];
  refresh: () => Promise<void>;
  onAction: (page: string, create?: boolean) => void;
  onContextSettings?: (providerId: string, modelName: string) => void;
}) {
  const [modelPreference, setModelPreference] = useState(() =>
    readModelPreference(conversationId),
  );
  const modelKey = modelPreference.key;
  function selectModel(key: string) {
    const next = { ...modelPreference, key };
    setModelPreference(next);
    storeModelPreference(conversationId, next);
  }
  const [chatOptions, setChatOptions] = useState(readChatOptions);
  function updateChatOptions(change: Partial<ChatOptions>) {
    const next = { ...chatOptions, ...change };
    setChatOptions(next);
    storeChatOptions(next);
  }
  // null while unknown; knowledge context only exists when retrieval is enabled.
  const [knowledgeEnabled, setKnowledgeEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    setModelPreference(readModelPreference(conversationId));
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
  const modelOptions = modelPreference.models[selected?.key || ""] || {
    thinking: false,
  };
  const contextTokens =
    modelOptions.contextTokens ?? selected?.model.context_tokens ?? 500000;
  const levels = selected?.model.reasoning_efforts || [];
  const hasThinkingOverride =
    modelOptions.thinkingOverride !== undefined &&
    (modelOptions.thinkingOverride === false
      ? thinkingControl !== "always"
      : !levels.length || levels.includes(modelOptions.reasoningEffort as (typeof levels)[number]));
  const reasoningEffort =
    hasThinkingOverride && modelOptions.thinkingOverride === true &&
    levels.includes(modelOptions.reasoningEffort as (typeof levels)[number])
      ? modelOptions.reasoningEffort
      : selected?.model.default_reasoning_effort || undefined;
  const thinkingEnabled =
    thinkingControl === "always" ||
    (thinkingControl !== "none" &&
      (hasThinkingOverride
        ? modelOptions.thinkingOverride === true
        : Boolean(selected?.model.default_thinking_enabled)));
  function updateModelOptions(patch: Partial<ModelOptions>) {
    if (!selected) return;
    const next = {
      ...modelPreference,
      key: selected.key,
      models: {
        ...modelPreference.models,
        [selected.key]: { ...modelOptions, ...patch },
      },
    };
    setModelPreference(next);
    storeModelPreference(conversationId, next);
  }
  const modelSelection = selected
    ? {
        provider_id: selected.profile.id,
        model_name: selected.model.name,
        thinking_enabled: thinkingEnabled,
        reasoning_effort: thinkingEnabled ? reasoningEffort : undefined,
        context_tokens: contextTokens,
        mode: chatOptions.mode,
        use_memory: chatOptions.useMemory,
        use_knowledge: chatOptions.useKnowledge,
      }
    : undefined;
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadedConversation, setLoadedConversation] = useState<string | null>(null);
  const contextualPlaceholder = useComposerPlaceholder(
    conversationId,
    messages,
    settings,
  );
  const [initialDraft] = useState(() => readChatDraft(conversationId));
  const [draft, setDraft] = useState(initialDraft?.text || "");
  const [images, setImages] = useState<Attachment[]>(
    initialDraft?.images || [],
  );
  const [attachmentBatch, setAttachmentBatch] = useState(0);
  const [stream, setStream] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [tasks, setTasks] = useState<ComplexTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [progress, setProgress] = useState({ stage: "", message: "" });
  const [liveCourses, setLiveCourses] = useState<Record<string, CourseReceipt[]>>({});
  const [courseDialog, setCourseDialog] = useState<CourseReceipt | null>(null);
  const pageOpenedAt = useRef(Date.now());
  const openedCourses = useRef(new Set<string>());
  const queuedInput = useRef(false);
  const trackNext = useRef<(value: Run, id: string) => Promise<void>>(undefined);
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
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [tools, setTools] = useState<RunEvent[]>([]);
  const [imageGeneration, setImageGeneration] =
    useState<ImageGenerationProgress | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const acceptedNewRun = useRef<{ run: Run; at: number } | null>(null);
  function openModelSettings() {
    if (selected && onContextSettings) onContextSettings(selected.profile.id, selected.model.name);
    else onAction("connections");
  }
  const [error, setError] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [busy, setBusy] = useState(false);
  const { activity: avatarActivity, begin: beginAvatar, finish: finishAvatar } =
    useAvatarActivity(`main:${conversationId || "new"}`, "main");
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editedText, setEditedText] = useState("");
  const turnElements = useRef(new Map<string, HTMLElement>());
  const [uploading, setUploading] = useState(false);
  const [buddyNote, setBuddyNote] = useState("");
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [composerSubmenu, setComposerSubmenu] = useState<"mcp" | "skills" | null>(null);
  const [movingProject, setMovingProject] = useState(false);
  const moveProjectLock = useRef(false);
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
      const next = { ...modelPreference, key: "" };
      setModelPreference(next);
      storeModelPreference(conversationId, next);
      setBuddyNote("原先选择的模型已移除，已切换为当前默认模型。");
    }
  }, [modelKey, modelPreference, settings.providers, conversationId]);
  const scroller = useRef<HTMLDivElement>(null);
  const chatSurface = useRef<HTMLDivElement>(null);
  useDesktopTaskRead(conversationId, loadedConversation === conversationId && messages.length > 0, chatSurface);
  const composerArea = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const dropTarget = useRef<HTMLDivElement>(null);
  const previewTarget = useRef<HTMLDivElement>(null);
  const attachmentPicker = useRef<HTMLInputElement>(null);
  const followLatest = useRef(true);
  const followFrame = useRef(0);
  const scheduleFollowLatest = useCallback(() => {
    if (!followLatest.current || followFrame.current) return;
    followFrame.current = requestAnimationFrame(() => {
      followFrame.current = 0;
      const container = scroller.current;
      if (!container || !followLatest.current) return;
      const bottom = Math.max(
        0,
        container.scrollHeight - container.clientHeight,
      );
      if (Math.abs(container.scrollTop - bottom) > 1)
        container.scrollTop = bottom;
    });
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(followFrame.current);
      followFrame.current = 0;
    },
    [conversationId],
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const imagesRef = useRef(images);
  draftRef.current = draft;
  imagesRef.current = images;
  const speech = useSpeechInput({
    scopeKey: `${conversationId || "new"}:${projectId || ""}:${attachmentBatch}`,
    input: composer,
    readText: () => draftRef.current,
    writeText: changeDraft,
    onError: setError,
    isVisible: () => document.visibilityState === "visible",
    isBlocked: () => submitting || stopping || uploading || movingProject,
  });
  useEffect(() => {
    const discard = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== conversationId) return;
      speech.cancel();
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
  // Every edit is saved immediately. Unmount must never restore a cleared draft.
  useLayoutEffect(() => {
    const saved = readChatDraft(conversationId);
    draftRef.current = saved?.text || "";
    imagesRef.current = saved?.images || [];
    setDraft(draftRef.current);
    setImages(imagesRef.current);
  }, [conversationId]);
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
  const focusInput = useCallback(() => {
    const input = composer.current;
    if (!input || input.disabled) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);
  function chooseStarter(prompt: string) {
    if (submitting || stopping || movingProject || speech.isLocked()) return;
    changeDraft(prompt);
    requestAnimationFrame(focusInput);
  }
  function focusComposer(note = "我在，想到什么就继续说吧。") {
    setBuddyNote(note);
    requestAnimationFrame(focusInput);
  }
  useEffect(() => {
    if (!buddyNote) return;
    const timer = window.setTimeout(() => setBuddyNote(""), 3600);
    return () => window.clearTimeout(timer);
  }, [buddyNote]);
  useEffect(() => {
    const frame = requestAnimationFrame(focusInput);
    return () => cancelAnimationFrame(frame);
  }, [conversationId, focusInput]);
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
      setLoadedConversation(id);
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
      beginAvatar(value);
      setRun(value);
      setBusy(true);
      setStream("");
      setReasoning("");
      setContextStatus("");
      setProgress({ stage: "", message: "" });
      queuedInput.current = false;
      let reasoningStep = "";
      setTools([]);
      setImageGeneration(null);
      try {
        const result = await readEvents(
          value.id,
          (event) => {
            if (watch.signal.aborted) return;
            if (event.kind === "progress") setProgress({ stage: String(event.data.stage || ""), message: String(event.data.message || "") });
            if (event.kind === "learning_course") {
              const course = event.data as unknown as CourseReceipt;
              setLiveCourses((values) => ({ ...values, [value.id]: [...(values[value.id] || []).filter((item) => item.goal_id !== course.goal_id), course] }));
              if (!queuedInput.current && course.status === "completed" && course.nodes.length && Date.parse(course.completed_at || "") >= pageOpenedAt.current) {
                const key = `bai-course-opened:${course.planning_run_id}`;
                if (!openedCourses.current.has(key)) {
                  openedCourses.current.add(key);
                  try {
                    if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, "seen"); setCourseDialog(course); }
                  } catch { setCourseDialog(course); }
                }
              }
            }
            if (event.kind === "task") {
              if (event.data.pending_messages === 0 && ["planning", "running"].includes(String(event.data.status))) queuedInput.current = false;
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
            if (event.kind === "context" && event.data.status === "usage")
              setContextUsage(event.data as ContextUsage);
            if (event.kind === "context" && event.data.status !== "usage")
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
        finishAvatar(result);
        // A failed reply explains itself in the conversation; no duplicate banner.
        if (["failed", "cancelled"].includes(result.status)) setError("");
        let loaded = false;
        try {
          loaded = await loadMessages(id);
        } catch {
          if (!watch.signal.aborted)
            setSyncWarning("回答状态已保存，聊天记录暂未刷新，请重试刷新。");
        }
        if (watch.signal.aborted) return;
        if (loaded) setStream("");
        if (typeof result.result.next_run_id === "string") {
          const next = await api<Run>(`/runs/${result.result.next_run_id}`);
          if (!watch.signal.aborted) void trackNext.current?.(next, id);
          return;
        }
        if (result.status === "completed") setReasoning("");
        setBusy(false);
        void refresh().catch(() => {
          if (!watch.signal.aborted)
            setSyncWarning("回答已结束，部分列表暂未刷新，请重试刷新。");
        });
      } catch (error) {
        if (!watch.signal.aborted) {
          finishAvatar({ ...value, status: "interrupted" });
          setError(errorMessage(error));
          setBusy(false);
        }
      }
    },
    [loadMessages, refresh, receiveMemory, updateTask, beginAvatar, finishAvatar],
  );
  trackNext.current = track;
  useEffect(() => {
    let live = true;
    setMessages([]);
    setStream("");
    setReasoning("");
    setContextStatus("");
    setContextUsage(null);
    setUploading(false);
    setTools([]);
    setImageGeneration(null);
    setMemoryNotice(null);
    setError("");
    setSyncWarning("");
    setRun(null);
    setTasks([]);
    setLiveCourses({});
    setCourseDialog(null);
    setProgress({ stage: "", message: "" });
    setSubmitting(false);
    setStopping(false);
    actionLock.current = false;
    actionSequence.current += 1;
    setBusy(false);
    setEditingMessageId("");
    setEditedText("");
    followLatest.current = true;
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
        .catch((error) => {
          if (live) setError(errorMessage(error));
        });
      const initialMessages = loadMessages(conversationId);
      void initialMessages.catch((error) => {
        if (live) setError(errorMessage(error));
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
            // A reply submitted on the new-chat screen can finish before its
            // conversation mounts. Only that fresh submission may celebrate.
            const accepted = acceptedNewRun.current;
            if (accepted?.run.id === values[0].id && Date.now() - accepted.at < 30000) {
              acceptedNewRun.current = null;
              beginAvatar(accepted.run);
              finishAvatar(values[0]);
            }
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
              .filter((event) => event.kind === "context" && event.data.status !== "usage")
              .at(-1);
            const usageEvent = history
              .filter(
                (event) =>
                  event.kind === "context" && event.data.status === "usage",
              )
              .at(-1);
            setContextUsage(
              usageEvent ? (usageEvent.data as ContextUsage) : null,
            );
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
            if (["failed", "cancelled"].includes(values[0].status)) setError("");
          }
        })
        .catch((error) => {
          if (live) setError(errorMessage(error));
        });
    }
    return () => {
      live = false;
      controller.current?.abort();
    };
  }, [conversationId, loadMessages, refresh, track, receiveMemory, beginAvatar, finishAvatar]);
  const candidates =
    memories?.filter(
      (value) =>
        value.state === "candidate" &&
        value.source_conversation_id === conversationId,
    ) || [];
  const empty = !messages.length && !busy && !stream && !reasoning && !run;
  useLayoutEffect(() => {
    const surface = chatSurface.current;
    const area = composerArea.current;
    if (empty || !surface || !area) return;
    let height = -1;
    function measure() {
      if (!surface || !area) return;
      const nextHeight = Math.ceil(area.getBoundingClientRect().height);
      if (nextHeight === height) return;
      height = nextHeight;
      surface.style.setProperty("--chat-composer-height", `${height}px`);
      scheduleFollowLatest();
    }
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(area);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      surface.style.removeProperty("--chat-composer-height");
    };
  }, [empty, scheduleFollowLatest]);
  useLayoutEffect(() => {
    scheduleFollowLatest();
  }, [
    messages,
    stream,
    reasoning,
    busy,
    conversationId,
    tasks,
    scheduleFollowLatest,
  ]);
  useEffect(() => {
    const target = thread.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scheduleFollowLatest);
    observer.observe(target);
    return () => observer.disconnect();
  }, [conversationId, empty, scheduleFollowLatest]);
  async function send(
    edited?: Pick<Message, "content" | "attachment_ids" | "local_references">,
  ) {
    const text = edited ? edited.content : draft;
    const attachmentIds = edited
      ? edited.attachment_ids
      : images.filter((x) => !x.local_path).map((x) => x.id);
    const localReferences = edited
      ? (edited.local_references || [])
          .filter((item) => item.active)
          .map((item) => String(item.path))
      : images.filter((x) => x.local_path).map((x) => x.local_path!);
    const supplement = busy && Boolean(run?.task_id);
    if (
      actionLock.current ||
      speech.isLocked() ||
      moveProjectLock.current ||
      (busy && !run) ||
      uploading ||
      (!text.trim() && !attachmentIds.length && !localReferences.length)
    )
      return false;
    actionLock.current = true;
    const sendingTo = conversationId;
    const submittedDraft = readChatDraft(sendingTo);
    const sequence = actionSequence.current;
    const isCurrent = () =>
      mounted.current &&
      currentId.current === sendingTo &&
      actionSequence.current === sequence;
    setSubmitting(true);
    setError("");
    if (!supplement) setBusy(true);
    followLatest.current = true;
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
          pinned: pinNew,
        });
        id = value.id;
      }
      const value = await api<Run>(`/conversations/${id}/messages`, "POST", {
        content: text.trim() || "请根据上传的附件帮助我分析。",
        attachment_ids: attachmentIds,
        local_references: localReferences,
        model_selection: modelSelection,
      });
      if (created) {
        storeModelPreference(id, { ...modelPreference, key: selected?.key || "" });
      }
      if (!isCurrent()) {
        if (!edited) clearChatDraft(sendingTo, submittedDraft);
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
        acceptedNewRun.current = { run: value, at: Date.now() };
        beginAvatar(value);
        onConversation(id);
      } else if (currentId.current === id) {
        if (!supplement || value.id !== run?.id) void track(value, id);
        else { queuedInput.current = true; setBuddyNote("已收到新消息，当前操作结束后处理。"); setProgress({ stage: "queued_input", message: "已收到新消息，当前操作结束后判断归属" }); }
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
        setError(errorMessage(error));
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
      if (isCurrent()) setError(errorMessage(error));
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
          model_selection: modelSelection,
        },
      );
      if (!isCurrent()) return;
      void track(value, id);
    } catch (error) {
      if (isCurrent()) setError(errorMessage(error));
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
  const hasDraft = Boolean(draft.trim() || images.length);
  const orderedTasks = [...tasks].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const currentTask = tasks.find(task => task.id === selectedTaskId)
    || tasks.find(task => task.id === run?.task_id)
    || orderedTasks[0];
  const showStop = busy && !hasDraft;
  async function changeProject(nextId: string | null) {
    if (
      moveProjectLock.current ||
      actionLock.current ||
      busy ||
      uploading ||
      nextId === projectId
    )
      return;
    if (!conversationId) {
      onProjectChange?.(nextId);
      return;
    }
    const id = conversationId;
    moveProjectLock.current = true;
    setMovingProject(true);
    setError("");
    let saved = false;
    try {
      const moved = await api<Conversation>(`/conversations/${id}`, "PATCH", {
        project_id: nextId,
      });
      saved = true;
      if (mounted.current && currentId.current === id)
        onProjectChange?.(moved.project_id || null, moved);
      await refresh();
    } catch (cause) {
      if (mounted.current && currentId.current === id)
        setError(
          saved
            ? "归属已保存，列表暂未刷新，请稍后重试。"
            : errorMessage(cause),
        );
    } finally {
      moveProjectLock.current = false;
      if (mounted.current) setMovingProject(false);
    }
  }
  return (
    <div className="chat-layout" ref={dropTarget}>
      <div
        className={`chat-main ${empty ? "is-empty new-chat-screen" : ""}`}
        ref={chatSurface}
      >
        <div
          className={`chat-scroll ${empty ? "is-empty" : ""}`}
          ref={scroller}
        >
          {empty ? (
            <NewChatWelcome timezone={settings.timezone} />
          ) : (
            <div className="message-list" ref={thread}>
              {messages.map(value => (
                <article
                  key={value.id}
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
                        activity={value.run_id === avatarActivity?.runId ? avatarActivity : undefined}
                        motion="still"
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
                    {value.role === "assistant" && <Reasoning text={value.reasoning || ""} />}
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
                                !value.attachment_ids.length &&
                                !(value.local_references || []).some(
                                  (item) => item.active,
                                ))
                            }
                            onClick={() =>
                              void send({
                                content: editedText,
                                attachment_ids: value.attachment_ids,
                                local_references: value.local_references,
                              })
                            }
                          >
                            发送修改
                          </Button>
                        </div>
                      </div>
                    ) : (
                      (
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
                    {value.role === "assistant" && (
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
                    {value.role === "assistant" && (
                      <AnswerActions
                        content={value.content}
                        onRetry={value === lastAssistant && value.run_id === run?.id &&
                          run?.status === "completed" && !run.task_id && run.retry_action === "retry"
                          ? () => void retry(value.run_id || undefined) : undefined}
                        retryDisabled={busy || submitting || uploading || !modelReady}
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
                      !value.task_id &&
                      !(value.run_id === run?.id && run?.task_id) &&
                      ["failed", "cancelled"].includes(
                        value.run_status ||
                          (value.run_id === run?.id ? run?.status || "" : ""),
                      ) && (
                        <IncompleteReplyNotice
                          cancelled={
                            (value.run_status || run?.status) === "cancelled"
                          }
                          reason={
                            value.run_error ||
                            (value.run_id === run?.id ? run?.error : null)
                          }
                          onSettings={() => openModelSettings()}
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

                    {value.role === "assistant" &&
                      value.run_id &&
                      value.has_learning_continuation && (
                        <LearningHandoffCards
                          runId={value.run_id}
                          status={value.run_status}
                        />
                      )}
                    {value.role === "assistant" && value.run_id && value.has_learning_course && <LearningCourseCards runId={value.run_id} onOpen={setCourseDialog} />}
                    {value.attachment_ids.length > 0 && (
                      <div className="message-pictures">
                        {value.attachment_ids.map((id) => (
                          <MessageAttachment id={id} key={id} />
                        ))}
                      </div>
                    )}
                    {value.role === "user" && editingMessageId !== value.id && (
                      <>
                        {!!value.local_references?.length && (
                          <div className="message-local-folders">
                            {value.local_references.map((reference, index) => (
                              <Hint key={index} label={String(reference.path || "需要重新关联")}><div
                                className="local-folder-chip"
                                tabIndex={0}
                              >
                                <Folder size={16} />
                                <span>
                                  {String(reference.name || "文件夹")}
                                </span>
                                <small>
                                  {reference.active ? "只读" : "需要重新关联"}
                                </small>
                              </div></Hint>
                            ))}
                          </div>
                        )}
                        <UserMessageActions
                          content={value.content}
                          disabled={busy || uploading}
                          onEdit={() => {
                            setEditingMessageId(value.id);
                            setEditedText(value.content);
                          }}
                        />
                      </>
                    )}
                  </div>
                </article>
              ))}
              {busy && (
                <article className="message assistant">
                  <div className="message-avatar assistant-avatar">
                    <BaiAvatar
                      interactive
                      motion="thinking"
                      activity={avatarActivity}
                      label="XiaoXi正在思考，点我继续聊天"
                      onClick={() => focusComposer("别急，我还在整理思路。")}
                    />
                  </div>
                  <div className="message-body">
                    <span className="message-name">XiaoXi</span>
                    <ReplyActivity
                      progress={progress.message}
                      reasoning={reasoning}
                      stream={stream}
                      imageGeneration={imageGeneration}
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
                        reason={incompleteRun.error}
                        onSettings={() => openModelSettings()}
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
              {currentTask && <div className="chat-task-panel">
                {tasks.length > 1 && <SoftSelect label="查看任务" value={currentTask.id}
                  onValueChange={setSelectedTaskId}
                  options={orderedTasks.map(task => ({ value: task.id, label: task.title || "历史任务" }))} />}
                <TaskCard key={currentTask.id} task={currentTask} busy={busy}
                  running={busy && run?.task_id === currentTask.id} onUpdate={updateTask}
                  onResume={taskId => void retry(undefined, taskId)} />
              </div>}
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
        {!empty && (
          <ChatScrollNavigation
            key={conversationId || "new"}
            turns={turns}
            scroller={scroller}
            thread={thread}
            turnElements={turnElements}
            followLatest={followLatest}
          />
        )}
        <div className="composer-area" ref={composerArea}>
          {busy && run && liveCourses[run.id]?.length > 0 && <LearningCourseCards runId={run.id} courses={liveCourses[run.id]} onOpen={setCourseDialog} />}
          <CourseOutline course={courseDialog} onClose={() => setCourseDialog(null)} />
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
                configurationProblem.test(error)
                  ? /语音|识别|麦克风/.test(error)
                    ? { label: "配置语音", onClick: () => onAction("speech") }
                    : { label: "配置接口", onClick: () => openModelSettings() }
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
              onClick={() => openModelSettings()}
            >
              <Cable size={16} />
              <span>先连接你的模型，就能开始对话和学习。</span>
              <ArrowRight size={15} />
            </button>
          )}
          <div className="composer">
            {onProjectChange && (
              <div className="chat-project-context">
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="chat-project-trigger"
                      aria-label={
                        conversationId ? "移动当前对话到项目" : "新对话所属项目"
                      }
                      disabled={
                        busy || submitting || uploading || movingProject
                      }
                    >
                      <Folder size={15} />
                      <span>
                        {projects.find((item) => item.id === projectId)?.name ||
                          "未加入项目"}
                      </span>
                      <ChevronDown size={13} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="project-menu project-choice-menu"
                      align="start"
                      side="top"
                      sideOffset={8}
                      collisionPadding={12}
                    >
                      <DropdownMenu.Label className="project-choice-label">
                        对话所属项目
                      </DropdownMenu.Label>
                      <DropdownMenu.RadioGroup
                        value={projectId || ""}
                        onValueChange={(id) => void changeProject(id || null)}
                      >
                        {[{ id: "", name: "未加入项目" }, ...projects].map(
                          (item) => (
                            <DropdownMenu.RadioItem
                              key={item.id}
                              value={item.id}
                              disabled={
                                busy || submitting || uploading || movingProject
                              }
                            >
                              <Folder size={14} />
                              <span>{item.name}</span>
                              <DropdownMenu.ItemIndicator>
                                <Check size={14} />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          ),
                        )}
                      </DropdownMenu.RadioGroup>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                {projectId && (
                  <>
                    <button
                      type="button"
                      onClick={() => onProjectOpen?.(projectId)}
                    >
                      项目概览
                    </button>
                    <button
                      type="button"
                      onClick={() => onLibrary?.(projectId)}
                    >
                      <Library size={14} />
                      资料库
                    </button>
                  </>
                )}
                {!conversationId && pinNew && (
                  <span className="chat-project-pin">
                    <Pin size={13} />
                    发送后置顶
                  </span>
                )}
                {movingProject && <span role="status">正在移动…</span>}
              </div>
            )}
            <div className="composer-attachments" ref={previewTarget} />
            <Textarea
              id="chat-message"
              ref={composer}
              aria-label="发送给XiaoXi的消息"
              value={draft}
              onChange={(e) => changeDraft(e.target.value)}
              placeholder={
                contextualPlaceholder ||
                (busy && run?.task_id
                  ? "补充当前任务要求…"
                  : modelReady
                    ? empty
                      ? "今天有什么灵感，随心输入"
                      : "输入消息…"
                    : "连接模型后开始对话")
              }
              rows={2}
              disabled={submitting || stopping}
              readOnly={speech.busy}
              onKeyDown={(e) => {
                if (speech.isLocked()) return;
                if (
                  e.key === "Tab" &&
                  !e.shiftKey &&
                  !e.ctrlKey &&
                  !e.altKey &&
                  !e.metaKey &&
                  !e.nativeEvent.isComposing &&
                  e.nativeEvent.keyCode !== 229 &&
                  e.currentTarget.value === "" &&
                  contextualPlaceholder
                ) {
                  e.preventDefault();
                  changeDraft(contextualPlaceholder);
                  return;
                }
                if (isSendShortcut(e)) {
                  e.preventDefault();
                  if (modelReady) void send();
                }
              }}
            />
            <div className="composer-bottom">
              <div className="composer-tools">
                <ImagesInput
                  allowFiles
                  allowFolders
                  hideTrigger
                  pickerRef={attachmentPicker}
                  dropTarget={dropTarget}
                  previewTarget={previewTarget}
                  scopeKey={`${conversationId || "new"}:${attachmentBatch}`}
                  images={images}
                  onChange={changeImages}
                  disabled={submitting || stopping || !modelReady}
                  onError={setError}
                  onUploading={setUploading}
                />
                <DropdownMenu.Root
                  modal={false}
                  open={composerMenuOpen}
                  onOpenChange={(open) => {
                    setComposerMenuOpen(open);
                    if (!open) setComposerSubmenu(null);
                    if (open)
                      void api<{ enabled: boolean }>("/knowledge/config")
                        .then((value) => setKnowledgeEnabled(value.enabled))
                        .catch(() => setKnowledgeEnabled(null));
                  }}
                >
                  <Hint label="添加附件、工具与检索设置">
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="composer-add-trigger"
                        aria-label="更多功能"
                      >
                        <Plus size={21} strokeWidth={1.6} />
                      </button>
                    </DropdownMenu.Trigger>
                  </Hint>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="model-menu composer-add-menu"
                      aria-label="更多功能"
                      align="start"
                      side="top"
                      sideOffset={8}
                      collisionPadding={16}
                    >
                      <DropdownMenu.Label className="model-menu-label composer-option-label">
                        检索 · 所有对话生效
                      </DropdownMenu.Label>
                      <DropdownMenu.CheckboxItem
                        className="model-menu-item composer-option"
                        checked={chatOptions.useMemory}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) =>
                          updateChatOptions({ useMemory: checked === true })
                        }
                      >
                        <span>记忆检索</span>
                        <span
                          className="mini-toggle"
                          data-checked={chatOptions.useMemory}
                          aria-hidden="true"
                        >
                          <span />
                        </span>
                      </DropdownMenu.CheckboxItem>
                      <DropdownMenu.CheckboxItem
                        className="model-menu-item composer-option"
                        checked={chatOptions.useKnowledge && knowledgeEnabled !== false}
                        disabled={knowledgeEnabled === false}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) =>
                          updateChatOptions({ useKnowledge: checked === true })
                        }
                      >
                        <span>知识库检索</span>
                        {knowledgeEnabled === false ? (
                          <span className="composer-option-state">未在知识库开启</span>
                        ) : (
                          <span
                            className="mini-toggle"
                            data-checked={chatOptions.useKnowledge}
                            aria-hidden="true"
                          >
                            <span />
                          </span>
                        )}
                      </DropdownMenu.CheckboxItem>
                      <DropdownMenu.Separator className="model-menu-separator" />
                      <DropdownMenu.Item
                        className="model-menu-item composer-add-menu-item"
                        disabled={submitting || stopping || !modelReady}
                        onSelect={() => attachmentPicker.current?.click()}
                      >
                        <ImagePlus size={16} />
                        添加文件或图片
                      </DropdownMenu.Item>
                      <ToolboxMenu
                        open={composerSubmenu === "mcp"}
                        onOpenChange={open => setComposerSubmenu(current => open ? "mcp" : current === "mcp" ? null : current)}
                        onSettings={() => {
                          setComposerMenuOpen(false);
                          setComposerSubmenu(null);
                          onAction("tools");
                        }}
                      />
                      <SkillsMenu
                        open={composerSubmenu === "skills"}
                        onOpenChange={open => setComposerSubmenu(current => open ? "skills" : current === "skills" ? null : current)}
                        onSettings={() => {
                          setComposerMenuOpen(false);
                          setComposerSubmenu(null);
                          onAction("skills");
                        }}
                      />
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <div
                  className="composer-mode-switch"
                  role="radiogroup"
                  aria-label="回答方式"
                  data-mode={chatOptions.mode}
                >
                  {(
                    [
                      ["agent", "智能体", "可调用工具、文件与技能，对所有对话生效"],
                      ["chat", "对话", "普通问答模式，不会调用工具，更省 token"],
                    ] as const
                  ).map(([value, label, description]) => (
                    <Hint key={value} label={description}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={chatOptions.mode === value}
                        className="composer-mode-option"
                        disabled={busy}
                        onClick={() => updateChatOptions({ mode: value })}
                      >
                        {label}
                      </button>
                    </Hint>
                  ))}
                </div>
              </div>
              <div className="composer-submit">
                <ComposerModelPicker
                  contextMeter={
                    <ContextMeter
                      usage={
                        contextUsage?.model_name === selected?.model.name &&
                        contextUsage?.provider_id === selected?.profile.id
                          ? contextUsage
                          : null
                      }
                      compacting={contextStatus === "正在整理上下文…"}
                      limit={contextTokens}
                    />
                  }
                  choices={choices}
                  selected={selected}
                  options={modelOptions}
                  thinkingEnabled={thinkingEnabled}
                  contextTokens={contextTokens}
                  disabled={busy}
                  defaultProvider={settings.default_provider}
                  onSelect={selectModel}
                  onOptions={updateModelOptions}
                  onSettings={() => openModelSettings()}
                />
                {isTauri() && (
                  <SpeechInputButton
                    speech={speech}
                    disabled={submitting || stopping || uploading || movingProject}
                  />
                )}
                <Hint
                  label={
                    submitting
                      ? "正在提交"
                      : stopping
                        ? "正在停止生成"
                        : showStop
                          ? "停止生成"
                          : "发送消息"
                  }
                >
                  <Button
                    className="composer-action"
                    data-action={showStop ? "stop" : "send"}
                    aria-label={
                      submitting
                        ? "正在提交"
                        : stopping
                          ? "正在停止生成"
                          : showStop
                            ? "停止生成"
                            : "发送消息"
                    }
                    aria-busy={submitting || stopping}
                    size="icon"
                    disabled={
                      submitting ||
                      movingProject ||
                      stopping ||
                      (!showStop && speech.busy) ||
                      (showStop ? !run : uploading || !modelReady || !hasDraft)
                    }
                    onClick={() => {
                      if (showStop) void stop();
                      else void send();
                    }}
                  >
                    {submitting || stopping ? (
                      <LoaderCircle
                        size={18}
                        className="composer-action-icon composer-action-progress size-[18px]"
                        aria-hidden="true"
                      />
                    ) : showStop ? (
                      <span className="composer-action-stop" aria-hidden="true" />
                    ) : (
                      <ArrowUp
                        size={18}
                        strokeWidth={2}
                        className="composer-action-icon size-[18px]"
                        aria-hidden="true"
                      />
                    )}
                  </Button>
                </Hint>
              </div>
            </div>
          </div>
        </div>
        {empty && (
          <NewChatStarters
            onPrompt={chooseStarter}
            onLearning={() => onAction("learning")}
            disabled={submitting || stopping || movingProject || speech.busy}
          />
        )}
      </div>
    </div>
  );
}
