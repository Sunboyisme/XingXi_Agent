import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
} from "@/lib/api";
import { ErrorNotice, ImagesInput, Markdown } from "./common";
import { MessageAttachment } from "./OfficeFiles";
import { ToolboxMenu } from "./ToolboxMenu";
import { SkillsMenu } from "./SkillsMenu";
import { Reasoning } from "./Reasoning";
import { AnswerPresentation } from "./AnswerPresentation";
import { AnswerActions } from "./AnswerActions";
import { BaiAvatar } from "./BaiAvatar";
import { ChatHome } from "./ChatHome";
import {
  MemoryReview,
  MemorySavedNotice,
  type MemoryNotice,
} from "./MemoryFeedback";

function IncompleteReplyNotice({ cancelled }: { cancelled: boolean }) {
  return (
    <div
      className={`incomplete-reply-notice ${cancelled ? "is-cancelled" : "is-failed"}`}
      role="status"
    >
      <AlertCircle size={15} />
      <div>
        <strong>{cancelled ? "回答停在这里" : "这次回答没有完成"}</strong>
        <p>
          {cancelled
            ? "已经完成的工具操作仍会保留，可以继续追问或重新生成。"
            : "可以重新生成，或者换个说法继续。"}
        </p>
      </div>
    </div>
  );
}

type StoredChatDraft = {
  text: string;
  images: Attachment[];
};

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
}: {
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
  const [modelKey, setModelKey] = useState("");
  const [thinking, setThinking] = useState(false);
  const choices = settings.providers.flatMap((profile) =>
    profile.models.map((model) => ({
      profile,
      model,
      key: `${profile.id}:${model.name}`,
    })),
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
  const initialDraft = useRef(readChatDraft(conversationId));
  const [draft, setDraft] = useState(initialDraft.current?.text || "");
  const [images, setImages] = useState<Attachment[]>(
    initialDraft.current?.images || [],
  );
  const [attachmentBatch, setAttachmentBatch] = useState(0);
  const [stream, setStream] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [contextStatus, setContextStatus] = useState("");
  const [tools, setTools] = useState<RunEvent[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [atLatest, setAtLatest] = useState(true);
  const [activeTurn, setActiveTurn] = useState("");
  const turnElements = useRef(new Map<string, HTMLElement>());
  const [uploading, setUploading] = useState(false);
  const [buddyNote, setBuddyNote] = useState("");
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
  const persistDraft = useCallback(
    (text = draftRef.current, attachments = imagesRef.current) => {
      storeChatDraft(conversationId, { text, images: attachments });
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
  const loadMessages = useCallback(async (id: string) => {
    const values = await api<Message[]>(`/conversations/${id}/messages`);
    if (currentId.current === id) setMessages(values);
  }, []);
  const track = useCallback(
    async (value: Run, id: string) => {
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
      try {
        const result = await readEvents(
          value.id,
          (event) => {
            if (watch.signal.aborted) return;
            if (event.kind === "delta")
              setStream((text) => text + String(event.data.text || ""));
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
        await loadMessages(id);
        await refresh();
        setStream("");
        if (result.status === "completed") setReasoning("");
        setBusy(false);
      } catch (error) {
        if (!watch.signal.aborted) {
          setError((error as Error).message);
          setBusy(false);
        }
      }
    },
    [loadMessages, refresh, receiveMemory],
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
    setMemoryNotice(null);
    setError("");
    setRun(null);
    setBusy(false);
    setActiveTurn("");
    followLatest.current = true;
    setAtLatest(true);
    if (conversationId) {
      const initialMessages = loadMessages(conversationId);
      void initialMessages.catch((error: Error) => {
        if (live) setError(error.message);
      });
      api<Run[]>(`/runs?conversation_id=${conversationId}`)
        .then(async (values) => {
          // Finish the initial snapshot before a later reload can replace it.
          await initialMessages;
          if (!live) return;
          const active = values.find((value) =>
            ["queued", "running"].includes(value.status),
          );
          if (active) void track(active, conversationId);
          else if (values[0]) {
            // A fast run can finish between the first message load and this request.
            // Restore the persisted answer and tool results, including fast runs.
            await loadMessages(conversationId);
            if (!live) return;
            const history = await api<RunEvent[]>(
              `/runs/${values[0].id}/tools`,
            );
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
            await refresh();
            if (!live) return;
            setRun(values[0]);
            if (values[0].status === "failed")
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
  useLayoutEffect(() => {
    const container = scroller.current;
    if (container && followLatest.current) {
      container.scrollTop = container.scrollHeight;
      setAtLatest(true);
    }
  });
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
  }, [conversationId]);
  async function send() {
    if (busy || uploading || (!draft.trim() && !images.length)) return;
    setError("");
    setBusy(true);
    followLatest.current = true;
    setAtLatest(true);
    try {
      let id = conversationId;
      const created = !id;
      if (!id) {
        const value = await api<Conversation>("/conversations", "POST", {
          title: "新对话",
        });
        id = value.id;
      }
      const value = await api<Run>(`/conversations/${id}/messages`, "POST", {
        content: draft.trim() || "请根据上传的附件帮助我分析。",
        attachment_ids: images.map((x) => x.id),
        model_selection: selected
          ? {
              provider_id: selected.profile.id,
              model_name: selected.model.name,
              thinking_enabled: thinkingEnabled,
            }
          : undefined,
      });
      setDraft("");
      setImages([]);
      imagesRef.current = [];
      draftRef.current = "";
      clearChatDraft(conversationId);
      if (created) clearChatDraft(null);
      setAttachmentBatch((value) => value + 1);
      await refresh();
      if (created) {
        // The conversation effect owns resuming a new conversation's run.
        onConversation(id);
      } else if (currentId.current === id) {
        await loadMessages(id);
        void track(value, id);
      }
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  async function retry() {
    if (!conversationId) return;
    setError("");
    try {
      void track(
        await api<Run>(`/conversations/${conversationId}/retry`, "POST"),
        conversationId,
      );
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const lastAssistant = messages
    .filter((value) => value.role === "assistant")
    .at(-1);
  const incompleteRun =
    !busy && run && ["failed", "cancelled"].includes(run.status) ? run : null;
  const orphanReasoning =
    Boolean(reasoning) &&
    !messages.some(
      (value) => value.role === "assistant" && value.reasoning === reasoning,
    );
  const showIncompleteReply =
    Boolean(incompleteRun && !lastAssistant) || orphanReasoning;
  const empty = !messages.length && !busy;
  const turns: (Message & { answer: string })[] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push({ ...message, answer: "" });
    else if (message.role === "assistant" && turns.length) {
      const turn = turns[turns.length - 1];
      turn.answer += (turn.answer ? "\n" : "") + message.content;
    }
  }
  if (busy && stream && turns.length) {
    const turn = turns[turns.length - 1];
    turn.answer += (turn.answer ? "\n" : "") + stream;
  }
  return (
    <div className="chat-layout" ref={dropTarget}>
      <div className={`chat-main ${empty ? "is-empty" : ""}`}>
        <div
          className={`chat-scroll ${empty ? "is-empty" : ""}`}
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            const latest =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              36;
            followLatest.current = latest;
            setAtLatest(latest);
            const boundary = element.getBoundingClientRect().top + 80;
            let current = turns[0]?.id || "";
            for (const turn of turns) {
              const target = turnElements.current.get(turn.id);
              if (target && target.getBoundingClientRect().top <= boundary)
                current = turn.id;
            }
            setActiveTurn(current);
          }}
          onWheel={(event) => {
            if (event.deltaY < 0) {
              followLatest.current = false;
              setAtLatest(false);
            }
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
              {messages.map((value) => (
                <article
                  className={`message ${value.role}`}
                  key={value.id}
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
                    {value.role === "assistant" && (
                      <Reasoning text={value.reasoning || ""} />
                    )}
                    <Markdown
                      runId={
                        value.role === "assistant"
                          ? value.run_id || undefined
                          : undefined
                      }
                    >
                      {value.content}
                    </Markdown>
                    {value.role === "assistant" && (
                      <AnswerPresentation
                        runId={value.run_id || undefined}
                        status={
                          value.run_id === run?.id ? run?.status : "completed"
                        }
                        content={value.content}
                      />
                    )}
                    {value.role === "assistant" && (
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
                            : "completed"
                        }
                        tools={
                          value === lastAssistant && run?.status === "completed"
                            ? tools
                            : undefined
                        }
                      />
                    )}
                    {value === lastAssistant && incompleteRun && (
                      <IncompleteReplyNotice
                        cancelled={incompleteRun.status === "cancelled"}
                      />
                    )}

                    {value.attachment_ids.length > 0 && (
                      <div className="message-pictures">
                        {value.attachment_ids.map((id) => (
                          <MessageAttachment id={id} key={id} />
                        ))}
                      </div>
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
                      label="XiaoXi正在思考，点我继续聊天"
                      onClick={() => focusComposer("别急，我还在整理思路。")}
                    />
                  </div>
                  <div className="message-body">
                    <span className="message-name">XiaoXi</span>
                    <Reasoning text={reasoning} active />
                    {stream ? (
                      <Markdown runId={run?.id}>{stream}</Markdown>
                    ) : (
                      <div
                        className="thinking"
                        role="status"
                        aria-live="polite"
                      >
                        <span className="thinking-label">
                          {contextStatus === "正在整理上下文…"
                            ? contextStatus
                            : tools.length
                              ? "正在整理查到的内容"
                              : reasoning
                                ? "正在把想法写成回答"
                                : "正在理清思路"}
                        </span>
                        <span className="thinking-dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                      </div>
                    )}
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
                    {incompleteRun && (
                      <IncompleteReplyNotice
                        cancelled={incompleteRun.status === "cancelled"}
                      />
                    )}
                    {incompleteRun && (
                      <AnswerActions
                        content=""
                        runId={incompleteRun.id}
                        runStatus={incompleteRun.status}
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
              message={error}
              retry={run?.status === "failed" ? () => void retry() : undefined}
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
              placeholder={modelReady ? "输入消息…" : "连接模型后开始对话"}
              rows={2}
              disabled={busy}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  if (modelReady && !busy) void send();
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
                  disabled={busy || !modelReady}
                  onError={setError}
                  onUploading={setUploading}
                />
                <ToolboxMenu onSettings={() => onAction("tools")} />
                <SkillsMenu onSettings={() => onAction("skills")} />
                <button
                  className="composer-thinking"
                  aria-label="思考模式"
                  aria-pressed={thinkingEnabled}
                  disabled={
                    busy ||
                    thinkingControl === "none" ||
                    thinkingControl === "always"
                  }
                  title={
                    thinkingControl === "none"
                      ? "此模型未配置思考开关"
                      : thinkingControl === "always"
                        ? "此模型始终开启思考"
                        : thinkingEnabled
                          ? "关闭思考模式"
                          : "开启思考模式"
                  }
                  onClick={() => setThinking(!thinking)}
                >
                  <Sparkles size={15} aria-hidden="true" />
                  <span>
                    {thinkingControl === "always" ? "始终思考" : "思考"}
                  </span>
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="composer-model"
                      aria-label="选择模型"
                      disabled={busy}
                      title={selected?.model.name || "配置模型"}
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
                {busy ? (
                  <Button
                    aria-label="停止生成"
                    size="icon"
                    onClick={() => {
                      if (run) void api(`/runs/${run.id}/cancel`, "POST");
                    }}
                  >
                    <Square size={15} />
                  </Button>
                ) : (
                  <Button
                    aria-label="发送消息"
                    size="icon"
                    disabled={
                      uploading ||
                      !modelReady ||
                      (!draft.trim() && !images.length)
                    }
                    onClick={() => void send()}
                  >
                    <ArrowUp size={19} />
                  </Button>
                )}
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
              changeDraft(text);
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
