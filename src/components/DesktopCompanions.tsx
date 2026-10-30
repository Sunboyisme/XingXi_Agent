import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AudioLines, Bell, Square, MessageCircle, ScanLine, X } from "lucide-react";
import { BaiAvatar } from "./BaiAvatar";
import { Hint } from "./common";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
import type { ComplexTask, Conversation } from "@/lib/api";
import { PetActivities, activityPhase, desktopTask, isActiveRun, presentDesktopTask, type AvatarActivity, type AvatarGesture, type DesktopTaskActivity, type DesktopTaskSnapshot } from "@/lib/avatarActivity";
import { DesktopTaskInbox, DESKTOP_TASK_READ_PREFIX, markDesktopTaskRead, type DesktopTaskRead } from "@/lib/desktopTaskInbox";
import {
  invoke,
  api,
  desktopListen,
  desktopError,
  type DesktopPreferences,
  type Run,
} from "@/lib/desktopAssistant";
type PetNotice = { id: string; title: string; body: string };
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
  const [inbox] = useState(() => new DesktopTaskInbox());
  const [tasks, setTasks] = useState(() => inbox.list(false));
  const [notifications, setNotifications] = useState<PetNotice[]>([]);
  const [readingNotice, setReadingNotice] = useState("");
  const readNotices = useRef(new Set<string>());
  const noticeReadLock = useRef(new Set<string>());
  const [quickShown, setQuickShown] = useState(false);
  const quickVisible = useRef(false);
  const quickEpoch = useRef(-1);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hoverState = useRef(false);
  const hoverTools = useRef<HTMLDivElement>(null);
  const [stopping, setStopping] = useState("");
  const [taskNames, setTaskNames] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<AvatarActivity>();
  const [gesture, setGesture] = useState<AvatarGesture>();
  const [activities] = useState(() => new PetActivities());
  const [collapsed, setCollapsed] = useState(true);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean; started: boolean } | null>(null);
  const dragSequence = useRef(0);
  const petElement = useRef<HTMLDivElement>(null);
  const presencePhase = useRef(presence.phase);
  presencePhase.current = presence.phase;
  const menuOpen = useRef(menu);
  menuOpen.current = menu;
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const rub = useRef<{ extreme: number; direction: number; turns: number; since: number } | null>(null);
  const rubCooldown = useRef(0);
  const suppressClick = useRef(false);
  const taskFingerprint = useRef("");
  const position = useRef({ x: 0, y: 0, scale: 1 });
  function acceptTasks(values: DesktopTaskActivity[]) {
    const result = activities.accept(values);
    const now = Date.now();
    setActivity(old => {
      if (result.active && result.current) return old?.phase === "working" && old.runId === result.current.runId
        ? old : { runId: result.current.runId, phase: "working", startedAt: now };
      if (result.success && presencePhase.current === "idle" && !document.hidden)
        return { runId: result.success.runId, phase: "success", startedAt: now };
      if (old?.phase === "working") return { ...old, phase: result.current && activityPhase(result.current) === "waiting" ? "waiting" : "idle", startedAt: now };
      return old;
    });
    const unread = inbox.accept(values);
    const fingerprint = JSON.stringify(unread);
    if (fingerprint !== taskFingerprint.current) {
      taskFingerprint.current = fingerprint;
      setTasks(unread);
    }
  }
  function strokePointer(event: PointerEvent) {
    const bounds = petElement.current?.getBoundingClientRect();
    const now = Date.now();
    if (!bounds || event.pointerType !== "mouse" || drag.current || menuOpen.current || presencePhase.current !== "idle" || now < rubCooldown.current ||
      event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.top + bounds.height * .4) {
      rub.current = null;
      return;
    }
    const stroke = rub.current;
    if (!stroke || now - stroke.since > 1000) {
      rub.current = { extreme: event.clientX, direction: 0, turns: 0, since: now };
      return;
    }
    const delta = event.clientX - stroke.extreme;
    const threshold = bounds.width * .08;
    if (!stroke.direction) {
      if (Math.abs(delta) >= threshold) { stroke.direction = Math.sign(delta); stroke.extreme = event.clientX; }
    } else if (delta * stroke.direction >= 0) stroke.extreme = event.clientX;
    else if (Math.abs(delta) >= threshold) {
      stroke.direction *= -1;
      stroke.extreme = event.clientX;
      if (++stroke.turns >= 3) {
        rubCooldown.current = now + 2000;
        rub.current = null;
        setGesture({ kind: "pet", startedAt: now });
      }
    }
  }
  useDesktopHitRegions(
    ".pet-avatar,.pet-hover-tools,.pet-floating-panel,.pet-menu,.pet-window .desktop-error,.ui-hint",
  );
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(""), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);
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
      if (!event.payload) { setMenu(false); setFocused(false); }
    });
    const refreshUnread = (value?: DesktopTaskRead) => {
      const unread = value ? inbox.read(value) : inbox.list();
      taskFingerprint.current = JSON.stringify(unread);
      setTasks(unread);
    };
    const storage = (event: StorageEvent) => {
      if (event.key?.startsWith(DESKTOP_TASK_READ_PREFIX)) refreshUnread();
    };
    const acceptQuickPresence = (value: { shown: boolean; epoch: number }) => {
      if (!alive || value.epoch <= quickEpoch.current) return;
      quickEpoch.current = value.epoch;
      quickVisible.current = value.shown;
      setQuickShown(value.shown);
      if (value.shown) setCollapsed(true);
    };
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
          presencePhase.current = value.shown ? "enter" : "leave";
          hoverState.current = false;
          setHovered(false);
          setFocused(false);
          drag.current = null;
          rub.current = null;
          setGesture(undefined);
          setActivity(old => old?.phase === "success" ? { ...old, phase: "idle" } : old);
          setMenu(false);
          setError("");
          setPresence({
            phase: value.shown ? "enter" : "leave",
            key: ++presenceKey.current,
          });
        },
      ),
      desktopListen("desktop-pet-hide-menu", () => setMenu(false)),
      desktopListen<{ dragId: number }>("desktop-pet-drag-started", (value) => {
        if (drag.current?.id !== value.dragId) return;
        drag.current.started = true;
        setGesture({ kind: "drag", startedAt: Date.now() });
      }),
      desktopListen<{ dragId: number }>("desktop-pet-drag-ended", (value) => {
        if (drag.current?.id !== value.dragId) return;
        drag.current = null;
        suppressClick.current = true;
        petElement.current?.style.removeProperty("--bai-tilt");
        if (presencePhase.current === "idle")
          setGesture({ kind: "drop", startedAt: Date.now() });
      }),
      desktopListen<{ x: number; y: number }>("desktop-cursor", (p) => {
        const point = { x: (p.x - position.current.x) / position.current.scale, y: (p.y - position.current.y) / position.current.scale };
        const inside = (element: HTMLElement | null) => {
          const r = element?.getBoundingClientRect();
          return r && point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
        };
        const nextHover = !drag.current?.started && Boolean(inside(petElement.current) || inside(hoverTools.current));
        if (nextHover !== hoverState.current) { hoverState.current = nextHover; setHovered(nextHover); }
        const old = cursor.current;
        cursor.current = p;
        if (drag.current?.started && old && petElement.current) {
          const tilt = Math.max(-12, Math.min(12, -(p.x - old.x) / position.current.scale / petElement.current.clientWidth * 60));
          petElement.current.style.setProperty("--bai-tilt", `${tilt}deg`);
        }
        window.dispatchEvent(
          new PointerEvent("pointermove", {
            clientX: point.x,
            clientY: point.y,
            pointerType: "mouse",
          }),
        );
      }),
      desktopListen<DesktopTaskActivity>("desktop-task", (value) => acceptTasks([value])),
      desktopListen<DesktopTaskRead>("desktop-task-read", value => refreshUnread(value)),
      desktopListen<{ shown: boolean; epoch: number }>("desktop-quick-presence", acceptQuickPresence),
      desktopListen<DesktopTaskSnapshot[]>("desktop-task-snapshot", values => {
        acceptTasks(values.map(presentDesktopTask));
        // /runs is limited to 30 recent entries. Older active work must still settle.
        const present = new Set(values.map(value => value.runId));
        const active = new Set([...activities.activeIds(), ...inbox.list().filter(task => isActiveRun(task.runStatus)).map(task => task.runId)]);
        void Promise.all([...active].filter(id => !present.has(id)).map(async id => {
          try {
            const run = await api<Run>(`/runs/${id}`);
            if (alive) acceptTasks([desktopTask(run, "poll")]);
          } catch { /* Keep a running task during a temporary connection failure. */ }
        }));
      }),
      desktopListen<PetNotice[]>(
        "desktop-notification",
        (notes) => {
          const unread = notes.filter(note => !readNotices.current.has(note.id));
          setNotifications(old => JSON.stringify(old) === JSON.stringify(unread) ? old : unread);
        },
      ),
    ];
    window.addEventListener("pointermove", strokePointer, { passive: true });
    window.addEventListener("storage", storage);
    // Older saved inbox entries predate run-kind metadata. Recheck them so old
    // selection results disappear without discarding unrelated unread chat work.
    void Promise.all(inbox.list().filter(task => !task.kind).map(async task => {
      try {
        const run = await api<Run>(`/runs/${task.runId}`);
        if (alive) acceptTasks([desktopTask(run, task.source)]);
      } catch { /* Keep existing unread work when the local service is unavailable. */ }
    }));
    void listeners[0]
      .then(() =>
        invoke<{
          preferences: DesktopPreferences;
          quickShown: boolean;
          quickEpoch: number;
        }>("desktop_preferences"),
      )
      .then(async (value) => {
        if (!alive) return;
        if (!layoutSeen) acceptPreferences(value);
        acceptQuickPresence({ shown: value.quickShown, epoch: value.quickEpoch });
        const shown = await w.isVisible();
        if (alive && presenceEpoch.current < 0 && shown) {
          presencePhase.current = "enter";
          setPresence({ phase: "enter", key: ++presenceKey.current });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      window.removeEventListener("pointermove", strokePointer);
      window.removeEventListener("storage", storage);
      listeners.forEach((p) => void p.then((f) => f()).catch(() => {}));
      void moved.then((f) => f());
      void focus.then((f) => f());
    };
  }, []);
  const taskTitlesKey = tasks.map(task => `${task.runId}:${task.taskId || ""}:${task.conversationId || ""}`).join("|");
  useEffect(() => {
    if (!tasks.length) return;
    let alive = true;
    const load = async () => {
      const [conversations, details] = await Promise.all([
        api<Conversation[]>("/conversations"),
        Promise.all(tasks.map(async task => task.taskId ? api<ComplexTask>(`/tasks/${task.taskId}`).catch(() => null) : null)),
      ]);
      const titles = Object.fromEntries(tasks.map((task, index) => [task.runId,
        details[index]?.title || details[index]?.goal || conversations.find(value => value.id === task.conversationId)?.title || task.title,
      ]));
      if (alive) setTaskNames(titles);
    };
    void load().catch(() => {});
    return () => { alive = false; };
  }, [taskTitlesKey]);
  useEffect(() => {
    if (menu)
      (
        document.querySelector(".pet-menu button") as HTMLButtonElement | null
      )?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(false);
        setError("");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [menu]);
  async function hidePet() {
    setError("");
    try {
      await invoke("desktop_preferences_save", {
        preferences: { pet: false },
      });
      setMenu(false);
    } catch (e) {
      setError(desktopError(e));
    }
  }
  async function openTask(value: DesktopTaskActivity) {
    setError("");
    if (value.conversationId || value.source !== "quick")
      await invoke("desktop_main", value.conversationId ? { conversationId: value.conversationId } : { page: "current" });
    else await invoke("desktop_resume", { runId: value.runId });
    if (!value.conversationId) {
      markDesktopTaskRead({ runId: value.runId });
      setTasks(inbox.list());
    }
  }
  async function stopTask(value: DesktopTaskActivity) {
    if (stopping || !isActiveRun(value.runStatus)) return;
    setError("");
    setStopping(value.runId);
    try {
      if (value.taskId) await api(`/tasks/${value.taskId}/cancel`, "POST");
      else await api(`/runs/${value.runId}/cancel`, "POST");
      const run = await api<Run>(`/runs/${value.runId}`);
      acceptTasks([desktopTask(run, value.source)]);
    } catch (error) { setError(desktopError(error)); }
    finally { setStopping(""); }
  }
  function startDesktopAsk(voice = false) {
    setError("");
    quickVisible.current = true;
    setQuickShown(true);
    setCollapsed(true);
    void (voice ? invoke("desktop_start", { newChat: false, voice: true }) : invoke("desktop_ai_open")).catch(error => { quickVisible.current = false; setQuickShown(false); setError(desktopError(error)); });
  }
  function openMainWindow() {
    setError("");
    void invoke("desktop_main", { page: "current" }).catch(error => setError(desktopError(error)));
  }
  const avatarSize = (82 * layout.size) / 100;
  const avatarTop = layout.y ?? 132;
  const avatarLeft = layout.x ?? window.innerWidth - avatarSize - 8;
  const updates = tasks.length + notifications.length;
  const panelBelow = avatarTop < 104;
  const panelHeight = Math.min(320, Math.max(1, updates) * 84,
    panelBelow ? window.innerHeight - avatarTop - avatarSize - 50 : avatarTop - 16);
  const panelTop = panelBelow ? avatarTop + avatarSize + 42 : avatarTop - panelHeight - 8;
  async function toggleInbox() {
    setError("");
    if (!updates) return;
    if (collapsed || quickShown) {
      await invoke("desktop_dismiss_quick");
      setCollapsed(false);
    } else setCollapsed(true);
  }
  async function openNotice(value: PetNotice) {
    await invoke("desktop_main", { page: "notifications" });
    await readNotice(value);
  }
  async function readNotice(value: PetNotice) {
    if (noticeReadLock.current.has(value.id)) return;
    noticeReadLock.current.add(value.id);
    setReadingNotice(value.id);
    setError("");
    try {
      await api(`/notifications/${value.id}/ack?read=true`, "POST");
      readNotices.current.add(value.id);
      setNotifications(old => old.filter(note => note.id !== value.id));
    } finally {
      noticeReadLock.current.delete(value.id);
      setReadingNotice(old => old === value.id ? "" : old);
    }
  }
  function readTask(task: DesktopTaskActivity) {
    const receipt = { runId: task.runId, at: Date.now() };
    markDesktopTaskRead(receipt);
    const unread = inbox.read(receipt);
    taskFingerprint.current = JSON.stringify(unread);
    setTasks(unread);
  }
  return (
    <main
      className="pet-window"
      data-presence={presence.phase}
      style={
        {
          "--pet-size": `${avatarSize}px`,
          "--pet-left": layout.x == null ? undefined : `${layout.x}px`,
          "--pet-top": layout.y == null ? undefined : `${layout.y}px`,
          "--pet-panel-top": `${panelTop}px`,
          "--pet-panel-height": `${Math.max(84, panelHeight)}px`,
          "--pet-tools-left": `${Math.max(6 - avatarLeft, Math.min(window.innerWidth - 152 - avatarLeft, avatarSize / 2 - 73))}px`,
          "--pet-menu-top": `${avatarTop >= 110 ? avatarTop - 108 : avatarTop + avatarSize + 8}px`,
        } as CSSProperties
      }
    >
      {!menu && presence.phase !== "leave" && !quickShown && !collapsed && updates > 0 && (
        <section className="pet-floating-panel" aria-label={`未读任务和提醒，共 ${updates} 条`}>
          {tasks.map(task => {
            const title = taskNames[task.runId] || task.title;
            return <article key={task.runId} className="pet-task-card" aria-label="未读任务">
              <Hint label="标为已读"><button className="pet-card-close" aria-label={`标为已读 ${title}`} onClick={() => readTask(task)}><X size={13} /></button></Hint>
              <Hint label={<><strong>{title}</strong><br />{task.status}</>}><button className="pet-task-copy" onClick={() => void openTask(task).catch(error => setError(desktopError(error)))}><strong>{title}</strong><span role="status">{task.status}</span></button></Hint>
              {isActiveRun(task.runStatus) && <Hint label="停止任务"><button className="pet-card-action" aria-label={`停止任务 ${title}`} disabled={Boolean(stopping)} onClick={() => void stopTask(task)}><Square size={16} fill="currentColor" /></button></Hint>}
            </article>;
          })}
          {notifications.map(note => <article key={note.id} className="pet-task-card" aria-label="未读提醒">
            <Hint label="标为已读"><button className="pet-card-close" aria-label={`标为已读 ${note.title}`} disabled={readingNotice === note.id} onClick={() => void readNotice(note).catch(error => setError(desktopError(error)))}><X size={13} /></button></Hint>
            <Hint label={<><strong>{note.title}</strong><br />{note.body}</>}><button className="pet-task-copy" onClick={() => void openNotice(note).catch(error => setError(desktopError(error)))}><strong>{note.title}</strong><span>{note.body}</span></button></Hint>
          </article>)}
        </section>
      )}
      {error && (
        <div className="desktop-error" role="alert">
          <span>{error}</span>
          <Hint label="关闭提示"><button className="pet-error-close" aria-label="关闭提示" onClick={() => setError("")}><X size={14} /></button></Hint>
        </div>
      )}
      {menu && (
        <div className="pet-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              openMainWindow();
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
              void invoke("desktop_main", { settings: true, settingsTab: "desktop" }).catch(error => setError(desktopError(error)));
            }}
          >
            设置
          </button>
        </div>
      )}
      <div
        ref={petElement}
        className="pet-avatar"
        onDoubleClick={event => {
          if ((event.target as HTMLElement).closest(".pet-hover-tools")) return;
          if (suppressClick.current || drag.current?.moved) return;
          openMainWindow();
        }}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
        onContextMenu={(e) => {
          e.preventDefault();
          setError("");
          void getCurrentWindow().setFocus();
          setMenu((m) => !m);
        }}
        onPointerDown={(e) => {
          if (e.button === 0) {
            e.currentTarget.querySelector("button")?.setPointerCapture(e.pointerId);
            suppressClick.current = false;
            rub.current = null;
            drag.current = { id: ++dragSequence.current, x: e.clientX, y: e.clientY, moved: false, started: false };
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
            const button = e.currentTarget.querySelector("button");
            if (button?.hasPointerCapture(e.pointerId)) button.releasePointerCapture(e.pointerId);
            void invoke<boolean>("desktop_pet_drag", { dragId: g.id }).then(started => {
              if (!started && drag.current?.id === g.id) { drag.current = null; setGesture(undefined); }
            }).catch((error) => {
              if (drag.current?.id !== g.id) return;
              drag.current = null;
              setGesture(undefined);
              setError(desktopError(error));
            });
          }
        }}
        onPointerUp={() => {
          const g = drag.current;
          if (g?.moved) suppressClick.current = true;
          if (!g?.moved) drag.current = null;
        }}
        onPointerCancel={() => {
          if (drag.current?.moved) suppressClick.current = true;
          if (!drag.current?.moved) drag.current = null;
        }}
      >
        <span
          key={presence.key}
          className="pet-appearance"
          data-phase={presence.phase}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget && presence.phase === "enter") {
              presencePhase.current = "idle";
              setPresence((value) => ({ ...value, phase: "idle" }));
            }
          }}
        >
          <BaiAvatar
            interactive
            label="桌面宠物，双击打开主窗口"
            activity={activity}
            gesture={gesture}
            presence={presence.phase}
            gazeRange={Infinity}
            pressFeedback="blink"
            onClick={(event) => {
              if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; return false; }
              if (event.detail === 0) openMainWindow();
            }}
          />
        </span>
        {(hovered || focused) && presence.phase === "idle" && gesture?.kind !== "drag" && !menu && (
          <div ref={hoverTools} className="pet-hover-tools" role="toolbar" aria-label="桌宠快捷操作" onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
            <Hint label="AI 对话"><button aria-label="AI 对话" onClick={() => startDesktopAsk()}><MessageCircle size={16} /></button></Hint>
            <button aria-label="截图" onClick={() => void invoke("desktop_capture_begin").catch(e => setError(desktopError(e)))}><ScanLine size={16} /></button>
            <span className="pet-toolbar-divider" />
            <Hint label="语音输入"><button aria-label="语音输入" onClick={() => startDesktopAsk(true)}><AudioLines size={16} /></button></Hint>
            <span className="pet-toolbar-divider" />
            <Hint label={updates ? `未读任务和提醒 · ${updates} 条` : "暂无未读任务和提醒"}><button aria-label="提醒和任务" aria-expanded={!collapsed && !quickShown && updates > 0} onClick={() => void toggleInbox().catch(error => setError(desktopError(error)))}><Bell size={16} />{updates > 0 && <span className="pet-update-count">{updates > 9 ? "9+" : updates}</span>}</button></Hint>
          </div>
        )}
      </div>
    </main>
  );
}
