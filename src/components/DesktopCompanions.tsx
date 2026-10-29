import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";
import { ChevronDown, Copy, X, RotateCw, GripVertical } from "lucide-react";
import { BaiAvatar, type AvatarDockEdge } from "./BaiAvatar";
import { Hint, Markdown } from "./common";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
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
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState<Settings>();
  const [modelKey, setModelKey] = useState("");
  const [target, setTarget] = useState("auto");
  const [action, setAction] = useState("explain");
  const owner = useRef("");
  const sequence = useRef(0);
  const activeRun = useRef("");
  const stream = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const mounted = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const resultBox = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const offers = useRef(0);
  function stop(report = true) {
    const id = owner.current;
    const next = ++sequence.current;
    stream.current?.abort();
    const run = activeRun.current;
    activeRun.current = "";
    locked.current = false;
    setBusy(false);
    if (run)
      void api(`/runs/${run}/cancel`, "POST").catch((e) => {
        if (
          report &&
          mounted.current &&
          owner.current === id &&
          sequence.current === next
        )
          setError(desktopError(e));
      });
  }
  function closeLocal() {
    offers.current++;
    owner.current = "";
    clearTimeout(copyTimer.current);
    stop(false);
    setSelection(undefined);
    setAnswer("");
    setNotice("");
    setError("");
    setExpanded(false);
  }
  function close() {
    const id = owner.current;
    closeLocal();
    if (id) void invoke("desktop_selection_dismiss", { id });
  }
  function accept(value: Selection | null) {
    if (!value || owner.current === value.id) return;
    offers.current++;
    clearTimeout(copyTimer.current);
    stop(false);
    owner.current = value.id;
    setSelection(value);
    setAnswer("");
    setNotice("");
    const issue =
      value.text.length > 20000
        ? "选中文字超过 20000 字，请缩小选择范围"
        : value.error || "";
    setError(issue);
    setExpanded(Boolean(issue));
    void api<Settings>("/settings")
      .then((s) => {
        if (mounted.current) setSettings(s);
      })
      .catch(() => {});
  }
  useEffect(() => {
    mounted.current = true;
    const listeners = [
      desktopListen<Selection>("desktop-selection", accept),
      desktopListen("desktop-selection-close", closeLocal),
    ];
    void Promise.all(listeners)
      .then(async () => {
        const version = offers.current;
        const snapshot = await invoke<Selection | null>(
          "desktop_selection_get",
        );
        if (mounted.current && offers.current === version) accept(snapshot);
      })
      .catch((e) => {
        if (mounted.current) setError(desktopError(e));
      });
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        !document.querySelector('[role="listbox"]')
      ) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      mounted.current = false;
      sequence.current++;
      owner.current = "";
      clearTimeout(copyTimer.current);
      stream.current?.abort();
      if (activeRun.current)
        void api(`/runs/${activeRun.current}/cancel`, "POST").catch(() => {});
      activeRun.current = "";
      locked.current = false;
      listeners.forEach((p) => void p.then((f) => f()));
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    if (selection)
      void invoke("desktop_selection_expand", {
        id: selection.id,
        expanded,
      }).catch((e) => setError(desktopError(e)));
  }, [selection?.id, expanded]);
  useEffect(() => {
    if (follow.current && resultBox.current)
      resultBox.current.scrollTop = resultBox.current.scrollHeight;
  }, [answer, busy]);
  async function copy(result = false) {
    const id = owner.current;
    try {
      await copyText(result ? answer : selection?.text || "");
      if (owner.current !== id) return;
      setNotice("已复制");
      if (!result && !expanded) {
        copyTimer.current = setTimeout(() => {
          if (owner.current === id) close();
        }, 800);
      }
    } catch (e) {
      if (owner.current === id) {
        setError(desktopError(e));
        setExpanded(true);
      }
    }
  }
  async function run(kind: string) {
    if (
      !selection?.text.trim() ||
      selection.text.length > 20000 ||
      locked.current ||
      owner.current !== selection.id
    )
      return;
    clearTimeout(copyTimer.current);
    const id = selection.id;
    const current = ++sequence.current;
    locked.current = true;
    setBusy(true);
    setExpanded(true);
    setError("");
    setNotice("");
    setAnswer("");
    setAction(kind);
    follow.current = true;
    const controller = new AbortController();
    stream.current = controller;
    try {
      if (modelKey && !models(settings).some((m) => m.key === modelKey))
        throw new Error("这个模型已不可用，请重新选择");
      const result = await api<Run>("/desktop/actions", "POST", {
        action: kind,
        text: selection.text,
        target_language: target,
        model_selection: selectedModel(settings, modelKey),
      });
      if (
        !mounted.current ||
        owner.current !== id ||
        sequence.current !== current ||
        controller.signal.aborted
      ) {
        await api(`/runs/${result.id}/cancel`, "POST");
        return;
      }
      activeRun.current = result.id;
      const completed = await readEvents(
        result.id,
        (e) => {
          if (
            !mounted.current ||
            owner.current !== id ||
            sequence.current !== current ||
            controller.signal.aborted
          )
            return;
          if (e.kind === "delta")
            setAnswer((a) => a + String(e.data.text || ""));
          if (e.kind === "answer") setAnswer(String(e.data.text || ""));
          if (e.kind === "error")
            setError(String(e.data.message || "处理失败"));
        },
        controller.signal,
      );
      if (
        mounted.current &&
        owner.current === id &&
        sequence.current === current
      ) {
        if (completed.error) setError(completed.error);
        const text = (completed.result as { text?: string })?.text;
        if (text) setAnswer(text);
        if (completed.status === "cancelled") setNotice("已停止");
      }
    } catch (e) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        owner.current === id &&
        sequence.current === current
      )
        setError(desktopError(e));
    } finally {
      if (
        mounted.current &&
        owner.current === id &&
        sequence.current === current
      ) {
        locked.current = false;
        activeRun.current = "";
        setBusy(false);
      }
    }
  }
  return (
    <main
      className={`selection-window ${expanded ? "is-expanded" : "is-compact"}`}
    >
      <header>
        <Hint label="拖动划词工具条">
          <button
            className="selection-grip"
            aria-label="拖动划词工具条"
            onPointerDown={(e) => {
              if (e.button === 0) void getCurrentWindow().startDragging();
            }}
          >
            <GripVertical size={16} />
          </button>
        </Hint>
        <div className="selection-actions">
          {[
            ["explain", "解释"],
            ["translate", "翻译"],
            ["summarize", "总结"],
          ].map(([kind, label]) => (
            <button
              key={kind}
              aria-pressed={expanded && action === kind}
              disabled={
                busy || !selection?.text || selection.text.length > 20000
              }
              onClick={() => void run(kind)}
            >
              {label}
            </button>
          ))}
          <button disabled={!selection?.text} onClick={() => void copy()}>
            <Copy size={15} />
            {notice === "已复制" && !expanded ? "已复制" : "复制"}
          </button>
        </div>
        <Hint label="关闭划词助手">
          <button aria-label="关闭划词助手" onClick={close}>
            <X size={16} />
          </button>
        </Hint>
      </header>
      {expanded && (
        <>
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
            {action === "translate" && (
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
            )}
          </div>
          <div
            ref={resultBox}
            className="selection-result"
            onScroll={(e) => {
              const node = e.currentTarget;
              follow.current =
                node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            }}
          >
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
          <footer>
            <button disabled={!answer} onClick={() => void copy(true)}>
              <Copy size={14} />
              {notice === "已复制" ? "已复制" : "复制结果"}
            </button>
            <span role="status">{notice !== "已复制" ? notice : ""}</span>
            {busy ? (
              <button
                onClick={() => {
                  stop();
                  setNotice("已停止");
                }}
              >
                停止
              </button>
            ) : (
              <button
                disabled={!selection?.text || selection.text.length > 20000}
                onClick={() => void run(action)}
              >
                <RotateCw size={14} />
                重试
              </button>
            )}
          </footer>
        </>
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
  const [layout, setLayout] = useState<{
    size: number;
    x?: number | null;
    y?: number | null;
    edges: AvatarDockEdge[];
  }>({ size: 100, edges: [] });
  const [task, setTask] = useState<PetTask | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const taskFingerprint = useRef("");
  const notificationFingerprint = useRef("");
  const position = useRef({ x: 0, y: 0, scale: 1 });
  useDesktopHitRegions(
    ".pet-avatar,.pet-bubble,.pet-menu,.pet-window .desktop-error,.ui-hint",
  );
  useEffect(() => {
    const w = getCurrentWindow();
    let alive = true;
    let layoutSeen = false;
    const acceptPreferences = (value: {
      preferences: DesktopPreferences;
      petDockEdges?: AvatarDockEdge[];
    }) => {
      if (!alive) return;
      layoutSeen = true;
      setLayout({
        size: value.preferences.petSize,
        x: value.preferences.petOffsetX,
        y: value.preferences.petOffsetY,
        edges: value.preferences.petSnap ? value.petDockEdges || [] : [],
      });
    };
    const update = async () => {
      const [p, scale] = await Promise.all([
        w.outerPosition(),
        w.scaleFactor(),
      ]);
      if (alive) position.current = { x: p.x, y: p.y, scale };
    };
    void update();
    const moved = w.onMoved(() => void update());
    const focus = w.onFocusChanged((event) => {
      if (!event.payload) setMenu(false);
    });
    const listeners = [
      desktopListen<{
        preferences: DesktopPreferences;
        petDockEdges?: AvatarDockEdge[];
      }>("desktop-preferences", acceptPreferences),
      desktopListen<{
        size: number;
        x: number;
        y: number;
        edges: AvatarDockEdge[];
      }>("desktop-pet-layout", (value) => {
        if (!alive) return;
        layoutSeen = true;
        setLayout(value);
      }),
      desktopListen("desktop-pet-undock", () =>
        setLayout((value) => ({ ...value, edges: [] })),
      ),
      desktopListen("desktop-pet-hide-menu", () => setMenu(false)),
      desktopListen("desktop-pet-drag-ended", () => {
        drag.current = null;
        suppressClick.current = true;
      }),
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
      desktopListen<{ id?: string; title: string; body: string }[]>(
        "desktop-notification",
        (notes) => {
          if (notes[0]) {
            const signature =
              notes[0].id || `${notes[0].title}:${notes[0].body}`;
            if (notificationFingerprint.current === signature) return;
            notificationFingerprint.current = signature;
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
    void listeners[0]
      .then(() =>
        invoke<{
          preferences: DesktopPreferences;
          petDockEdges?: AvatarDockEdge[];
        }>("desktop_preferences"),
      )
      .then((value) => {
        if (alive && !layoutSeen) acceptPreferences(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
      listeners.forEach((p) => void p.then((f) => f()));
      void moved.then((f) => f());
      void focus.then((f) => f());
    };
  }, []);
  useEffect(() => {
    if (menu)
      (
        document.querySelector(".pet-menu button") as HTMLButtonElement | null
      )?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [menu]);
  async function hidePet() {
    try {
      await invoke("desktop_preferences_save", {
        preferences: { pet: false },
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
  const avatarSize = (82 * layout.size) / 100;
  const avatarTop = layout.y ?? 132;
  return (
    <main
      className="pet-window"
      style={
        {
          "--pet-size": `${avatarSize}px`,
          "--pet-left": layout.x == null ? undefined : `${layout.x}px`,
          "--pet-top": layout.y == null ? undefined : `${layout.y}px`,
          "--pet-bubble-top": `${avatarTop >= 100 ? Math.max(5, avatarTop - 96) : avatarTop + avatarSize + 12}px`,
          "--pet-menu-top": `${avatarTop >= 110 ? avatarTop - 108 : avatarTop + avatarSize + 8}px`,
        } as CSSProperties
      }
    >
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
            void invoke("desktop_toggle").catch((e) =>
              setError(desktopError(e)),
            );
          suppressClick.current = false;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setError("");
          void getCurrentWindow().setFocus();
          setMenu((m) => !m);
        }}
        onPointerDown={(e) => {
          if (e.button === 0) {
            e.currentTarget.setPointerCapture(e.pointerId);
            suppressClick.current = false;
            drag.current = { x: e.clientX, y: e.clientY, moved: false };
          }
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (!g || g.moved || !(e.buttons & 1)) return;
          const dx = e.clientX - g.x,
            dy = e.clientY - g.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) {
            g.moved = true;
            setLayout((value) => ({ ...value, edges: [] }));
            suppressClick.current = true;
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
            void invoke("desktop_pet_drag").catch((e) => {
              drag.current = null;
              setError(desktopError(e));
            });
          }
        }}
        onPointerUp={() => {
          const g = drag.current;
          if (g?.moved) suppressClick.current = true;
          drag.current = null;
        }}
        onPointerCancel={() => {
          if (drag.current?.moved) suppressClick.current = true;
          drag.current = null;
        }}
      >
        <BaiAvatar
          dockEdges={layout.edges}
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
