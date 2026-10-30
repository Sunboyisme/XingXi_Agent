import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BookOpen,
  BookmarkPlus,
  Check,
  Copy,
  Languages,
  ListCollapse,
  Loader2,
  MessageSquare,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import {
  api,
  desktopError,
  desktopListen,
  invoke,
  models,
  readEvents,
  selectedModel,
  type Settings,
} from "@/lib/desktopAssistant";
import { useCopyFeedback } from "@/lib/clipboard";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
import { BaiAvatar } from "./BaiAvatar";
import { CommonTextEditor } from "./CommonTextEditor";
import { ErrorNotice, Hint, Markdown } from "./common";
import { Reasoning } from "./Reasoning";
import { SoftSelect } from "./ui/soft-select";
import "../styles/selection-assistant.css";

type Snapshot = {
  id: number;
  text: string;
  error: string;
  x: number;
  y: number;
};
type Action = "explain" | "translate" | "summarize";
const actionLabels: Record<Action, string> = {
  explain: "解释",
  translate: "翻译",
  summarize: "总结",
};

export function SelectionAssistant() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [settings, setSettings] = useState<Settings>();
  const [modelKey, setModelKey] = useState("");
  const [language, setLanguage] = useState("auto");
  const [action, setAction] = useState<Action>();
  const [answer, setAnswer] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [reasoningActive, setReasoningActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState(false);
  const [asking, setAsking] = useState(false);
  const [configError, setConfigError] = useState("");
  const [reloadSettings, setReloadSettings] = useState(0);
  const sourceCopy = useCopyFeedback(snapshot?.text || "");
  const resultCopy = useCopyFeedback(answer);
  const current = useRef<Snapshot | undefined>(undefined);
  const latestSnapshot = useRef(0);
  const mounted = useRef(false);
  const operation = useRef(0);
  const runId = useRef<string | null>(null);
  const tracker = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);
  const stoppingLock = useRef(false);
  const askingLock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const root = useRef<HTMLElement>(null);
  const commands = useRef({ accept, hide, dismiss });
  commands.current = { accept, hide, dismiss };
  useDesktopHitRegions(
    ".selection-window,.ui-hint,[role=dialog],[role=listbox],[data-slot=dialog-overlay]",
  );

  function invalidate() {
    operation.current++;
    tracker.current?.abort();
    tracker.current = null;
    const id = runId.current;
    runId.current = null;
    stopRequested.current = false;
    stoppingLock.current = false;
    if (id) void api(`/runs/${id}/cancel`, "POST").catch(() => {});
  }
  function hide(id = 0) {
    if (id && id < latestSnapshot.current) return;
    latestSnapshot.current = Math.max(latestSnapshot.current, id);
    invalidate();
    current.current = undefined;
    setSnapshot(undefined);
    setAction(undefined);
    setEditor(false);
    setBusy(false);
    setStopping(false);
    setAsking(false);
    askingLock.current = false;
  }
  function accept(value: Snapshot) {
    if (!value.id || value.id <= latestSnapshot.current) return;
    latestSnapshot.current = value.id;
    invalidate();
    current.current = value;
    setSnapshot(value);
    setAction(undefined);
    setAnswer("");
    setReasoning("");
    setReasoningActive(false);
    setBusy(false);
    setStopping(false);
    setIncomplete(false);
    setError("");
    setNotice("");
    setEditor(false);
    setAsking(false);
    askingLock.current = false;
  }
  function dismiss() {
    const id = current.current?.id;
    if (id)
      void invoke("selection_dismiss", { id }).catch((cause) => {
        if (mounted.current) setError(desktopError(cause));
      });
  }
  useEffect(() => {
    mounted.current = true;
    const stops = [
      desktopListen<Snapshot>("selection-snapshot", (value) => {
        if (mounted.current) commands.current.accept(value);
      }),
      desktopListen<number>("selection-hidden", (id) => {
        if (mounted.current) commands.current.hide(id);
      }),
      getCurrentWindow().onFocusChanged((event) => {
        if (!event.payload && mounted.current) {
          const id = current.current?.id;
          void getCurrentWindow()
            .isFocused()
            .then((focused) => {
              if (!focused && mounted.current && id === current.current?.id)
                commands.current.dismiss();
            })
            .catch(() => {});
        }
      }),
    ];
    void Promise.all(stops)
      .then(() => invoke<Snapshot>("selection_snapshot"))
      .then((value) => {
        if (mounted.current) commands.current.accept(value);
      })
      .catch((cause) => {
        if (mounted.current) setError(desktopError(cause));
      });
    return () => {
      mounted.current = false;
      invalidate();
      for (const stop of stops)
        void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setConfigError("");
    void api<Settings>("/settings", "GET", undefined, {
      signal: controller.signal,
      timeoutMs: 10000,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSettings(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setConfigError(desktopError(cause));
      });
    return () => controller.abort();
  }, [reloadSettings, snapshot?.id]);
  useLayoutEffect(() => {
    if (!snapshot) return;
    let active = true;
    const expandedHeight = editor ? 650 : action ? 590 : 96;
    const resize = () => {
      if (active)
        void invoke("selection_resize", {
          id: snapshot.id,
          width: 720,
          height: Math.max(
            expandedHeight,
            (root.current?.scrollHeight || 64) + 20,
          ),
        }).catch((cause) => {
          if (active) setError(desktopError(cause));
        });
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (root.current) observer.observe(root.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [snapshot?.id, action, editor]);
  useEffect(() => {
    const element = scroll.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [answer, reasoning]);

  async function cancel(id: string, own: number) {
    if (stoppingLock.current) return;
    stoppingLock.current = true;
    setStopping(true);
    try {
      await api(`/runs/${id}/cancel`, "POST");
      if (mounted.current && own === operation.current) {
        tracker.current?.abort();
        runId.current = null;
        setBusy(false);
        setIncomplete(true);
        setReasoningActive(false);
      }
    } catch (cause) {
      if (mounted.current && own === operation.current) {
        stopRequested.current = false;
        setError(`停止未完成：${desktopError(cause)}`);
      }
    } finally {
      if (mounted.current && own === operation.current) {
        stoppingLock.current = false;
        setStopping(false);
      }
    }
  }
  async function stop() {
    stopRequested.current = true;
    setStopping(true);
    if (runId.current) await cancel(runId.current, operation.current);
  }
  async function process(next: Action) {
    const material = current.current;
    if (!material?.text || askingLock.current) return;
    invalidate();
    const own = operation.current;
    setAction(next);
    setAnswer("");
    setReasoning("");
    setReasoningActive(false);
    setError("");
    setNotice("");
    setBusy(true);
    setStopping(false);
    setIncomplete(false);
    following.current = true;
    try {
      const selected = selectedModel(settings, modelKey);
      const run = await api<{ id: string }>("/desktop/actions", "POST", {
        action: next,
        text: material.text,
        target_language: language,
        model_selection: selected,
      });
      if (
        !mounted.current ||
        own !== operation.current ||
        material.id !== current.current?.id
      ) {
        void api(`/runs/${run.id}/cancel`, "POST").catch(() => {});
        return;
      }
      runId.current = run.id;
      if (stopRequested.current) {
        await cancel(run.id, own);
        return;
      }
      const controller = new AbortController();
      tracker.current = controller;
      const result = await readEvents(
        run.id,
        (event) => {
          if (!mounted.current || own !== operation.current) return;
          if (event.kind === "delta") {
            setReasoningActive(false);
            setAnswer((value) => value + String(event.data.text || ""));
          }
          if (event.kind === "reasoning") {
            setReasoningActive(true);
            setReasoning((value) => value + String(event.data.text || ""));
          }
          if (event.kind === "error")
            setError(String(event.data.message || "处理未完成，请重试"));
        },
        controller.signal,
      );
      if (!mounted.current || own !== operation.current) return;
      setIncomplete(result.status !== "completed");
      if (result.result?.text) setAnswer(String(result.result.text));
      if (result.error) setError(result.error);
      runId.current = null;
      setBusy(false);
    } catch (cause) {
      if (
        mounted.current &&
        own === operation.current &&
        !tracker.current?.signal.aborted
      ) {
        setError(desktopError(cause));
        setIncomplete(true);
        // Keep a known run stoppable if only its event connection failed.
        if (!runId.current) setBusy(false);
      }
    } finally {
      if (mounted.current && own === operation.current) {
        setReasoningActive(false);
        if (!runId.current) {
          setBusy(false);
          setStopping(false);
        }
      }
    }
  }
  if (!snapshot) return null;
  const choices = models(settings);
  const selectedKey = choices.some((model) => model.key === modelKey)
    ? modelKey
    : choices.find(
        (model) =>
          model.selection.provider_id === settings?.default_provider &&
          model.selection.model_name === settings?.model_name,
      )?.key || "";
  const toolDisabled = !snapshot.text || asking || editor;
  return (
    <main
      className="selection-window"
      ref={root}
      aria-label="划词助手"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !editor &&
          !document.querySelector("[role=listbox]")
        ) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <div className="selection-toolbar">
        <span className="selection-avatar">
          <BaiAvatar />
        </span>
        <button
          disabled={toolDisabled}
          onClick={async () => {
            if (askingLock.current) return;
            askingLock.current = true;
            setAsking(true);
            setError("");
            const id = snapshot.id;
            try {
              await invoke("selection_ask", { id });
            } catch (cause) {
              if (current.current?.id === id) setError(desktopError(cause));
            } finally {
              if (current.current?.id === id) {
                askingLock.current = false;
                setAsking(false);
              }
            }
          }}
        >
          {asking ? (
            <Loader2 size={16} className="spin" />
          ) : (
            <MessageSquare size={16} />
          )}
          问 AI
        </button>
        <button
          disabled={toolDisabled}
          aria-pressed={action === "explain"}
          onClick={() => void process("explain")}
        >
          <BookOpen size={16} />
          解释
        </button>
        <button
          disabled={toolDisabled}
          aria-pressed={action === "translate"}
          onClick={() => void process("translate")}
        >
          <Languages size={16} />
          翻译
        </button>
        <button
          disabled={toolDisabled}
          aria-pressed={action === "summarize"}
          onClick={() => void process("summarize")}
        >
          <ListCollapse size={16} />
          总结
        </button>
        <button disabled={toolDisabled} onClick={() => setEditor(true)}>
          <BookmarkPlus size={16} />
          添加到常用文本
        </button>
        <Hint label={sourceCopy.copied ? "已复制选中文字" : "复制选中文字"}>
          <button
            disabled={toolDisabled}
            onClick={() => void sourceCopy.copy()}
          >
            {sourceCopy.copied ? <Check size={16} /> : <Copy size={16} />}
            {sourceCopy.copied ? "已复制" : "复制"}
          </button>
        </Hint>
        <Hint label="关闭划词助手（Esc）">
          <button
            className="selection-close"
            aria-label="关闭划词助手"
            onClick={dismiss}
          >
            <X size={15} />
          </button>
        </Hint>
      </div>
      {(snapshot.error || error || sourceCopy.error || resultCopy.error) && (
        <ErrorNotice
          message={
            snapshot.error || error || sourceCopy.error || resultCopy.error
          }
        />
      )}
      {notice && (
        <p className="selection-notice" role="status">
          {notice}
        </p>
      )}
      {sourceCopy.copied && (
        <span className="sr-only" role="status">
          已复制选中文字
        </span>
      )}
      {action && (
        <section
          className="selection-result"
          aria-label={`${actionLabels[action]}结果`}
        >
          <div className="selection-result-options">
            <SoftSelect
              label="处理模型"
              value={selectedKey}
              onValueChange={setModelKey}
              options={choices.map((model) => ({
                value: model.key,
                label: model.label,
              }))}
              placeholder="选择模型"
              disabled={busy}
            />
            {action === "translate" && (
              <SoftSelect
                label="翻译目标语言"
                value={language}
                onValueChange={setLanguage}
                disabled={busy}
                options={[
                  { value: "auto", label: "自动中英互译" },
                  { value: "简体中文", label: "简体中文" },
                  { value: "English", label: "English" },
                ]}
              />
            )}
          </div>
          {configError && (
            <ErrorNotice
              message={configError}
              retry={() => setReloadSettings((n) => n + 1)}
            />
          )}
          <details className="selection-source">
            <summary>选中文字</summary>
            <div>{snapshot.text}</div>
          </details>
          <div
            className="selection-answer"
            ref={scroll}
            tabIndex={0}
            onWheel={(event) => {
              if (event.deltaY < 0) following.current = false;
            }}
            onScroll={(event) => {
              const node = event.currentTarget;
              following.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 24;
            }}
          >
            <Reasoning
              text={reasoning}
              active={reasoningActive}
              incomplete={incomplete}
            />
            {answer && <Markdown>{answer}</Markdown>}
            {busy && (
              <p className="selection-progress" role="status">
                <Loader2 size={14} className="spin" />
                {stopping
                  ? "正在停止…"
                  : reasoningActive
                    ? "正在思考…"
                    : "正在处理…"}
              </p>
            )}
            {!busy && !answer && !reasoning && !error && (
              <p className="common-text-muted">点击重试开始处理。</p>
            )}
            {!busy && incomplete && (
              <p className="common-text-muted">处理未完成，已有内容已保留。</p>
            )}
          </div>
          <div className="selection-result-actions">
            {busy ? (
              <button disabled={stopping} onClick={() => void stop()}>
                <Square size={14} />
                {stopping ? "停止中…" : "停止"}
              </button>
            ) : (
              <button onClick={() => void process(action)}>
                <RotateCcw size={14} />
                重试
              </button>
            )}
            <button disabled={!answer} onClick={() => void resultCopy.copy()}>
              {resultCopy.copied ? <Check size={14} /> : <Copy size={14} />}
              {resultCopy.copied ? "已复制" : "复制结果"}
            </button>
          </div>
        </section>
      )}
      {editor && (
        <CommonTextEditor
          key={snapshot.id}
          initialContent={snapshot.text}
          onClose={() => setEditor(false)}
          onSaved={() => {
            setEditor(false);
            setNotice("已添加到常用文本");
          }}
        />
      )}
    </main>
  );
}
