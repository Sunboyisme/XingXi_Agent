import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";
import { ChevronDown, X } from "lucide-react";
import { BaiAvatar } from "./BaiAvatar";
import { Hint } from "./common";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
import {
  invoke,
  desktopListen,
  desktopError,
  type DesktopPreferences,
} from "@/lib/desktopAssistant";
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
  }>({ size: 100 });
  const [presence, setPresence] = useState<{
    phase: "enter" | "leave" | "idle";
    key: number;
  }>({ phase: "idle", key: 0 });
  const presenceEpoch = useRef(-1);
  const presenceKey = useRef(0);
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
    const acceptPreferences = (value: { preferences: DesktopPreferences }) => {
      if (!alive) return;
      layoutSeen = true;
      setLayout({
        size: value.preferences.petSize,
        x: value.preferences.petOffsetX,
        y: value.preferences.petOffsetY,
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
      }>("desktop-preferences", acceptPreferences),
      desktopListen<{
        size: number;
        x: number;
        y: number;
      }>("desktop-pet-layout", (value) => {
        if (!alive) return;
        layoutSeen = true;
        setLayout(value);
      }),
      desktopListen<{ shown: boolean; epoch: number }>(
        "desktop-pet-presence",
        (value) => {
          if (!alive || value.epoch <= presenceEpoch.current) return;
          presenceEpoch.current = value.epoch;
          setMenu(false);
          setPresence({
            phase: value.shown ? "enter" : "leave",
            key: ++presenceKey.current,
          });
        },
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
        }>("desktop_preferences"),
      )
      .then(async (value) => {
        if (!alive) return;
        if (!layoutSeen) acceptPreferences(value);
        const shown = await w.isVisible();
        if (alive && presenceEpoch.current < 0 && shown)
          setPresence({ phase: "enter", key: ++presenceKey.current });
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
      data-presence={presence.phase}
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
        <span
          key={presence.key}
          className="pet-appearance"
          data-phase={presence.phase}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget && presence.phase === "enter")
              setPresence((value) => ({ ...value, phase: "idle" }));
          }}
        >
          <BaiAvatar
            interactive
            label="打开 XiaoXi 桌面问答"
            motion={task?.status.includes("正在") ? "thinking" : "idle"}
          />
        </span>
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
