import { useEffect, useRef, useState } from "react";
import {
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import { ChevronDown, Copy, X, RotateCw } from "lucide-react";
import { BaiAvatar } from "./BaiAvatar";
import { Hint, Markdown } from "./common";
import {
  api,
  invoke,
  desktopListen,
  desktopError,
  models,
  selectedModel,
  readEvents,
  copyText,
  type Settings,
  type Run,
  type DesktopPreferences,
} from "@/lib/desktopAssistant";

type Selection = { id: string; text: string; error?: string };
export function DesktopSelection() {
  const [selection, setSelection] = useState<Selection>();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<Settings>();
  const [modelKey, setModelKey] = useState("");
  const [target, setTarget] = useState("auto");
  const [action, setAction] = useState("explain");
  const owner = useRef("");
  const actionSequence = useRef(0);
  const activeRun = useRef("");
  const stream = useRef<AbortController | null>(null);
  const lock = useRef(false);
  function stop() {
    actionSequence.current++;
    stream.current?.abort();
    if (activeRun.current)
      void api(`/runs/${activeRun.current}/cancel`, "POST").catch((e) =>
        setError(desktopError(e)),
      );
    activeRun.current = "";
    setBusy(false);
    lock.current = false;
  }
  function close() {
    owner.current = "";
    stop();
    void getCurrentWindow().hide();
  }
  useEffect(() => {
    let alive = true;
    void api<Settings>("/settings")
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch((e) => {
        if (alive) setError(desktopError(e));
      });
    const listener = desktopListen<Selection>("desktop-selection", (value) => {
      stop();
      owner.current = value.id;
      setSelection(value);
      setAnswer("");
      setError(
        value.text.length > 20000
          ? "选中文字超过 20000 字，请缩小选择范围"
          : value.error || "",
      );
    });
    const closeListener = desktopListen("desktop-selection-close", close);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", key);
    return () => {
      alive = false;
      owner.current = "";
      stream.current?.abort();
      if (activeRun.current)
        void api(`/runs/${activeRun.current}/cancel`, "POST").catch(() => {});
      void listener.then((f) => f());
      void closeListener.then((f) => f());
      window.removeEventListener("keydown", key);
    };
  }, []);
  async function run(kind: string) {
    if (
      !selection ||
      !selection.text.trim() ||
      selection.text.length > 20000 ||
      lock.current
    )
      return;
    const id = selection.id;
    const sequence = ++actionSequence.current;
    lock.current = true;
    setBusy(true);
    setError("");
    setAnswer("");
    setAction(kind);
    const controller = new AbortController();
    stream.current = controller;
    try {
      const result = await api<Run>("/desktop/actions", "POST", {
        action: kind,
        text: selection.text,
        target_language: target,
        model_selection: selectedModel(settings, modelKey),
      });
      if (
        owner.current !== id ||
        sequence !== actionSequence.current ||
        controller.signal.aborted
      ) {
        await api(`/runs/${result.id}/cancel`, "POST");
        return;
      }
      activeRun.current = result.id;
      const completed = await readEvents(
        result.id,
        (e) => {
          if (owner.current !== id || sequence !== actionSequence.current)
            return;
          if (e.kind === "delta")
            setAnswer((a) => a + String(e.data.text || ""));
          if (e.kind === "error")
            setError(String(e.data.message || "处理失败"));
        },
        controller.signal,
      );
      if (owner.current === id && sequence === actionSequence.current) {
        if (completed.error) setError(completed.error);
        const text = (completed.result as { text?: string })?.text;
        if (text) setAnswer(text);
      }
    } catch (e) {
      if (
        !controller.signal.aborted &&
        owner.current === id &&
        sequence === actionSequence.current
      )
        setError(desktopError(e));
    } finally {
      if (owner.current === id && sequence === actionSequence.current) {
        setBusy(false);
        lock.current = false;
        activeRun.current = "";
      }
    }
  }
  return (
    <main className="selection-window">
      <header data-tauri-drag-region>
        <div className="selection-actions">
          {[
            ["explain", "解释"],
            ["translate", "翻译"],
            ["summarize", "总结"],
          ].map(([kind, label]) => (
            <button
              key={kind}
              disabled={
                busy || !selection?.text || selection.text.length > 20000
              }
              onClick={() => void run(kind)}
            >
              {label}
            </button>
          ))}
          <button
            disabled={!selection?.text}
            onClick={() =>
              void copyText(selection?.text || "").catch((e) =>
                setError(desktopError(e)),
              )
            }
          >
            <Copy size={15} />
            复制
          </button>
        </div>
        <Hint label="关闭">
          <button aria-label="关闭划词助手" onClick={close}>
            <X size={16} />
          </button>
        </Hint>
      </header>
      <div className="selection-controls">
        <select
          aria-label="划词模型"
          value={modelKey}
          disabled={busy}
          onChange={(e) => setModelKey(e.target.value)}
        >
          <option value="">默认模型</option>
          {models(settings).map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          aria-label="翻译目标语言"
          value={target}
          disabled={busy}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="auto">中译英／其他译中</option>
          <option>简体中文</option>
          <option>English</option>
        </select>
      </div>
      <div className="selection-result">
        <Markdown>{answer}</Markdown>
        {busy && <p role="status">正在处理…</p>}
        {error && (
          <p className="desktop-error" role="alert">
            {error}
          </p>
        )}
        {!answer && !busy && !error && (
          <p className="selection-preview">{selection?.text}</p>
        )}
      </div>
      {(answer || error) && (
        <footer>
          <button
            disabled={!answer}
            onClick={() =>
              void copyText(answer).catch((e) => setError(desktopError(e)))
            }
          >
            <Copy size={14} />
            复制结果
          </button>
          {busy ? (
            <button onClick={stop}>停止</button>
          ) : (
            <button
              onClick={() => void run(action)}
              disabled={!selection?.text}
            >
              <RotateCw size={14} />
              重试
            </button>
          )}
        </footer>
      )}
    </main>
  );
}

type PetTask = {
  title: string;
  status: string;
  conversationId?: string | null;
  notification?: boolean;
  source?: string;
};
export function DesktopPet() {
  const [task, setTask] = useState<PetTask | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const taskFingerprint = useRef("");
  const position = useRef({ x: 0, y: 0, scale: 1 });
  useEffect(() => {
    const w = getCurrentWindow();
    let alive = true;
    const update = async () => {
      const [p, scale] = await Promise.all([
        w.outerPosition(),
        w.scaleFactor(),
      ]);
      if (alive) position.current = { x: p.x, y: p.y, scale };
    };
    void update();
    const moved = w.onMoved(() => void update());
    const listeners = [
      desktopListen<{ x: number; y: number }>("desktop-cursor", (p) => {
        window.dispatchEvent(
          new PointerEvent("pointermove", {
            clientX: (p.x - position.current.x) / position.current.scale,
            clientY: (p.y - position.current.y) / position.current.scale,
            pointerType: "mouse",
          }),
        );
      }),
      desktopListen<PetTask>("desktop-task", (value) => {
        const fingerprint = JSON.stringify(value);
        if (fingerprint === taskFingerprint.current) return;
        taskFingerprint.current = fingerprint;
        setTask(value);
        setCollapsed(false);
      }),
      desktopListen<{ title: string; body: string }[]>(
        "desktop-notification",
        (notes) => {
          if (notes[0]) {
            setTask({
              title: notes[0].title,
              status: notes[0].body,
              notification: true,
            });
            setCollapsed(false);
          }
        },
      ),
    ];
    return () => {
      alive = false;
      listeners.forEach((p) => void p.then((f) => f()));
      void moved.then((f) => f());
    };
  }, []);
  useEffect(() => {
    void invoke("desktop_pet_interactive", {
      expanded: Boolean(menu || (task && !collapsed)),
    });
  }, [menu, task, collapsed]);
  async function hidePet() {
    try {
      const value = await invoke<{ preferences: DesktopPreferences }>(
        "desktop_preferences",
      );
      await invoke("desktop_preferences_save", {
        preferences: { ...value.preferences, pet: false },
      });
      setMenu(false);
    } catch (e) {
      setError(desktopError(e));
    }
  }
  async function openTask() {
    if (task?.notification || task?.source === "main")
      await invoke("desktop_main", { conversationId: task?.conversationId });
    else await invoke("desktop_open", { capture: false });
  }
  return (
    <main className="pet-window">
      {task && !collapsed && (
        <div className="pet-bubble">
          <button
            onClick={() =>
              void openTask().catch((e) => setError(desktopError(e)))
            }
          >
            <strong>{task.title}</strong>
            <span>{task.status}</span>
          </button>
          <Hint label="收起气泡">
            <button aria-label="收起气泡" onClick={() => setCollapsed(true)}>
              <ChevronDown size={17} />
            </button>
          </Hint>
        </div>
      )}
      {error && (
        <p className="desktop-error" role="alert">
          {error}
        </p>
      )}
      {menu && (
        <div className="pet-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              void invoke("desktop_main", {});
            }}
          >
            打开主窗口
          </button>
          <button role="menuitem" onClick={() => void hidePet()}>
            隐藏桌宠
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              void invoke("desktop_main", { settings: true });
            }}
          >
            设置
          </button>
        </div>
      )}
      <div
        className="pet-avatar"
        onClick={() => {
          if (!suppressClick.current)
            void invoke("desktop_open", { capture: true }).catch((e) =>
              setError(desktopError(e)),
            );
          suppressClick.current = false;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu((m) => !m);
        }}
        onPointerDown={(e) => {
          if (e.button === 0) {
            e.currentTarget.setPointerCapture(e.pointerId);
            suppressClick.current = false;
            drag.current = { x: e.screenX, y: e.screenY, moved: false };
          }
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (!g) return;
          const dx = e.screenX - g.x,
            dy = e.screenY - g.y;
          if (Math.abs(dx) + Math.abs(dy) > 5) {
            g.moved = true;
            void getCurrentWindow()
              .setPosition(
                new PhysicalPosition(
                  position.current.x + dx * position.current.scale,
                  position.current.y + dy * position.current.scale,
                ),
              )
              .catch((e) => setError(desktopError(e)));
            g.x = e.screenX;
            g.y = e.screenY;
          }
        }}
        onPointerUp={() => {
          const g = drag.current;
          suppressClick.current = Boolean(g?.moved);
          drag.current = null;
          if (g?.moved)
            void invoke<{ preferences: DesktopPreferences }>(
              "desktop_preferences",
            )
              .then((v) =>
                invoke("desktop_preferences_save", {
                  preferences: {
                    ...v.preferences,
                    petX: position.current.x,
                    petY: position.current.y,
                  },
                }),
              )
              .catch((e) => setError(desktopError(e)));
        }}
      >
        <BaiAvatar
          interactive
          label="打开 XiaoXi 桌面问答"
          motion={task?.status.includes("正在") ? "thinking" : "idle"}
        />
      </div>
    </main>
  );
}

export function DesktopPinned() {
  const [image, setImage] = useState("");
  const [error, setError] = useState("");
  const [opacity, setOpacity] = useState(1);
  useEffect(() => {
    void invoke<string>("pinned_image")
      .then(setImage)
      .catch((e) => setError(desktopError(e)));
  }, []);
  return (
    <main className="pinned-window" style={{ opacity }}>
      <img
        src={image}
        draggable={false}
        alt="钉住的截图"
        onPointerDown={(e) => {
          if (e.button === 0) void getCurrentWindow().startDragging();
        }}
        onWheel={(e) => {
          void getCurrentWindow()
            .outerSize()
            .then((size) =>
              getCurrentWindow().setSize(
                new PhysicalSize(
                  Math.max(40, size.width * (e.deltaY < 0 ? 1.1 : 0.9)),
                  Math.max(40, size.height * (e.deltaY < 0 ? 1.1 : 0.9)),
                ),
              ),
            );
        }}
      />
      <div className="pinned-controls">
        <label>
          透明度
          <input
            type="range"
            aria-label="贴图透明度"
            min="0.15"
            max="1"
            step="0.05"
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
          />
        </label>
        <Hint label="关闭贴图">
          <button
            aria-label="关闭贴图"
            onClick={() => void getCurrentWindow().close()}
          >
            <X size={17} />
          </button>
        </Hint>
      </div>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
