import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  BookOpen,
  BookmarkPlus,
  Check,
  Copy,
  Languages,
  FileText,
  Loader2,
  RotateCcw,
  Square,
  Volume2,
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
import { copyText } from "@/lib/clipboard";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
import { useReadAloud } from "@/lib/useReadAloud";
import { BaiAvatar } from "./BaiAvatar";
import { notifyCommonTextsChanged } from "@/lib/commonTexts";
import { ErrorNotice, Hint, Markdown } from "./common";
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
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [error, setError] = useState("");
  const reading = useReadAloud(setError);
  const [notice, setNotice] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [savedText, setSavedText] = useState(false);
  const saveRequest = useRef<number | null>(null);
  const [configError, setConfigError] = useState("");
  const [reloadSettings, setReloadSettings] = useState(0);
  const [copied, setCopied] = useState<"source" | "result" | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const feedbackEpoch = useRef(0);
  const copyRequest = useRef<object | null>(null);
  const current = useRef<Snapshot | undefined>(undefined);
  const latestSnapshot = useRef(0);
  const mounted = useRef(false);
  const operation = useRef(0);
  const runId = useRef<string | null>(null);
  const tracker = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);
  const stoppingLock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const root = useRef<HTMLElement>(null);
  const commands = useRef({ accept, hide, dismiss });
  commands.current = { accept, hide, dismiss };
  useDesktopHitRegions(
    ".selection-window,.ui-hint,[role=dialog],[role=listbox],[data-slot=dialog-overlay]",
  );

  function clearFeedback() {
    feedbackEpoch.current++;
    clearTimeout(feedbackTimer.current);
  }
  function success(message: string, id: number) {
    clearFeedback();
    const own = feedbackEpoch.current;
    setNotice(message);
    feedbackTimer.current = setTimeout(() => {
      if (
        mounted.current &&
        own === feedbackEpoch.current &&
        current.current?.id === id
      )
        commands.current.dismiss();
    }, 1200);
  }
  async function copy(value: string, kind: "source" | "result") {
    const material = current.current;
    if (!material || !value || copyRequest.current) return;
    const request = {};
    copyRequest.current = request;
    const own = operation.current;
    clearFeedback();
    setError("");
    setNotice("");
    try {
      await copyText(value);
      if (
        mounted.current &&
        own === operation.current &&
        current.current?.id === material.id
      ) {
        setCopied(kind);
        success(
          kind === "source" ? "已复制选中文字" : "已复制结果",
          material.id,
        );
      }
    } catch {
      if (
        mounted.current &&
        own === operation.current &&
        current.current?.id === material.id
      )
        setError("复制失败，请重试或选择文字后复制。");
    } finally {
      if (copyRequest.current === request) copyRequest.current = null;
    }
  }
  function invalidate() {
    reading.stop();
    clearFeedback();
    copyRequest.current = null;
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
    setSavingText(false);
    setSavedText(false);
    saveRequest.current = null;
    setBusy(false);
    setStopping(false);
    setCopied(null);
  }
  function accept(value: Snapshot) {
    if (!value.id || value.id <= latestSnapshot.current) return;
    latestSnapshot.current = value.id;
    invalidate();
    current.current = value;
    setSnapshot(value);
    setAction(undefined);
    setAnswer("");
    setBusy(false);
    setStopping(false);
    setIncomplete(false);
    setError("");
    setNotice("");
    setSavingText(false);
    setSavedText(false);
    saveRequest.current = null;
    setCopied(null);
  }
  function dismiss() {
    const id = current.current?.id;
    if (id)
      void invoke("selection_dismiss", { id }).catch((cause) => {
        if (mounted.current && current.current?.id === id)
          setError(desktopError(cause));
      });
  }
  useEffect(() => {
    mounted.current = true;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector(
          '[role="listbox"],[role="dialog"],[role="menu"]',
        )
      ) {
        event.preventDefault();
        commands.current.dismiss();
      }
    };
    window.addEventListener("keydown", escape);
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
      window.removeEventListener("keydown", escape);
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
    const expandedHeight = action ? 590 : 140;
    const resize = () => {
      if (active)
        void invoke("selection_resize", {
          id: snapshot.id,
          width: action
            ? 720
            : Math.ceil(
                (root.current?.getBoundingClientRect().width || 640) + 16,
              ),
          height: Math.max(
            expandedHeight,
            (root.current?.scrollHeight || 64) + (action ? 20 : 64),
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
  }, [snapshot?.id, action]);
  useEffect(() => {
    const element = scroll.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [answer]);

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
    if (!material?.text) return;
    invalidate();
    const own = operation.current;
    setAction(next);
    setAnswer("");
    setCopied(null);
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
        model_selection: {
          ...selected,
          thinking_enabled: false,
          reasoning_effort: null,
        },
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
            setAnswer((value) => value + String(event.data.text || ""));
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
  const toolDisabled = !snapshot.text;
  return (
    <main
      className={`selection-window${action ? " has-result" : ""}`}
      ref={root}
      aria-label="划词助手"
    >
      <div className="selection-toolbar">
        <div className="selection-actions">
          <span className="selection-avatar">
            <BaiAvatar motion="still" />
          </span>
          <Hint
            side="bottom"
            label={
              reading.kind === "source" ? "停止朗读选中文字" : "朗读选中文字"
            }
          >
            <button
              disabled={toolDisabled}
              aria-label={
                reading.kind === "source" ? "停止朗读选中文字" : "朗读选中文字"
              }
              aria-pressed={reading.kind === "source"}
              onClick={() => {
                clearFeedback();
                setNotice("");
                setError("");
                void reading.toggle(snapshot.text, "source", snapshot.id);
              }}
            >
              {reading.kind === "source" ? (
                reading.phase === "loading" ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Square size={16} />
                )
              ) : (
                <Volume2 size={16} />
              )}
              朗读
            </button>
          </Hint>
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
            <FileText size={16} />
            总结
          </button>
          <button
            disabled={toolDisabled || savingText || savedText}
            onClick={async () => {
              const material = current.current;
              if (
                !material?.text ||
                saveRequest.current === material.id ||
                savedText
              )
                return;
              saveRequest.current = material.id;
              const own = operation.current;
              clearFeedback();
              setSavingText(true);
              setError("");
              setNotice("");
              try {
                await api("/common-texts", "POST", {
                  content: material.text,
                  category_id: null,
                });
                notifyCommonTextsChanged();
                if (
                  mounted.current &&
                  current.current?.id === material.id &&
                  own === operation.current
                ) {
                  setSavedText(true);
                  success("已添加到默认分类", material.id);
                }
              } catch (cause) {
                if (
                  mounted.current &&
                  current.current?.id === material.id &&
                  own === operation.current
                )
                  setError(desktopError(cause));
              } finally {
                if (saveRequest.current === material.id) {
                  saveRequest.current = null;
                  if (mounted.current) setSavingText(false);
                }
              }
            }}
          >
            {savingText ? (
              <Loader2 size={16} className="spin" />
            ) : savedText ? (
              <Check size={16} />
            ) : (
              <BookmarkPlus size={16} />
            )}
            添加到常用文本
          </button>
          <Hint
            side="bottom"
            label={copied === "source" ? "已复制选中文字" : "复制选中文字"}
          >
            <button
              disabled={toolDisabled}
              onClick={() => void copy(snapshot.text, "source")}
            >
              {copied === "source" ? <Check size={16} /> : <Copy size={16} />}
              复制
            </button>
          </Hint>
        </div>
        <Hint side="bottom" label="关闭划词助手（Esc）">
          <button
            className="selection-close"
            aria-label="关闭划词助手"
            onClick={dismiss}
          >
            <X size={15} />
          </button>
        </Hint>
      </div>
      {(snapshot.error || error) && (
        <ErrorNotice message={snapshot.error || error} />
      )}
      {notice && (
        <p className="selection-notice" role="status">
          {notice}
        </p>
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
            {answer && <Markdown>{answer}</Markdown>}
            {busy && (
              <p className="selection-progress" role="status">
                <Loader2 size={14} className="spin" />
                {stopping ? "正在停止…" : "正在处理…"}
              </p>
            )}
            {!busy && !answer && !error && (
              <p className="common-text-muted">点击重试开始处理。</p>
            )}
            {!busy && incomplete && (
              <p className="common-text-muted">处理未完成，已有内容已保留。</p>
            )}
          </div>
          <div className="selection-result-actions">
            {action === "translate" && (
              <button
                disabled={!answer || busy}
                aria-pressed={reading.kind === "translation"}
                onClick={() => {
                  clearFeedback();
                  setNotice("");
                  setError("");
                  void reading.toggle(answer, "translation", snapshot.id);
                }}
              >
                {reading.kind === "translation" ? (
                  reading.phase === "loading" ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Square size={14} />
                  )
                ) : (
                  <Volume2 size={14} />
                )}
                {reading.kind === "translation"
                  ? reading.phase === "loading"
                    ? "合成中…"
                    : "停止朗读"
                  : "朗读译文"}
              </button>
            )}
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
            <button
              disabled={!answer}
              onClick={() => void copy(answer, "result")}
            >
              {copied === "result" ? <Check size={14} /> : <Copy size={14} />}
              复制结果
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
