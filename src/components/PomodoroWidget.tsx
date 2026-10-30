import { useEffect, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ContextMenu } from "radix-ui";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Pause,
  Play,
  Square,
} from "lucide-react";
import { Hint } from "./common";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
import type { DesktopPreferences } from "@/lib/desktopAssistant";
import {
  pomodoroThemes,
  readPomodoroTheme,
  type PomodoroTheme,
} from "@/lib/pomodoroAppearance";
import {
  formatCountdown,
  pomodoroAction,
  pomodoroStatus,
  primaryPomodoroAction,
  usePomodoro,
} from "@/lib/pomodoro";
import "../styles/pomodoro-widget.css";

export function PomodoroWidget() {
  const { data, remaining, busy, error, refresh } = usePomodoro();
  const [localError, setLocalError] = useState("");
  const [controlsOpen, setControlsOpen] = useState(false);
  const [anchor, setAnchor] = useState({ right: false, bottom: false });
  const strip = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [themeChooser, setThemeChooser] = useState(false);
  const [theme, setTheme] = useState<PomodoroTheme>("follow");
  const [themeReady, setThemeReady] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const alive = useRef(false);
  const themeSaving = useRef(false);
  const contextMenu = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const expanded = controlsOpen;
  useDesktopHitRegions(
    ".pomodoro-widget,.pomodoro-widget-menu,.ui-hint,.ui-hint-arrow",
    true,
  );
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let revision = 0;
    type Snapshot = { preferences: DesktopPreferences };
    const accept = (snapshot: Snapshot) => {
      if (disposed) return;
      setTheme(readPomodoroTheme(snapshot.preferences.pomodoroTheme));
      setThemeReady(true);
    };
    const stop = listen<Snapshot>("desktop-preferences", (event) => {
      revision++;
      accept(event.payload);
    });
    void stop
      .then(async () => {
        if (disposed) return;
        const before = revision;
        const snapshot = await invoke<Snapshot>("desktop_preferences");
        if (before === revision) accept(snapshot);
      })
      .catch((cause) => {
        if (!disposed) setLocalError(String(cause));
      });
    return () => {
      disposed = true;
      alive.current = false;
      void stop.then((dispose) => dispose()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.pomodoroTheme = theme;
    return () => {
      delete document.documentElement.dataset.pomodoroTheme;
    };
  }, [theme]);
  useEffect(() => {
    if (!menuOpen) return;
    const frame = requestAnimationFrame(() =>
      contextMenu.current
        ?.querySelector<HTMLElement>(
          themeChooser
            ? '[role="menuitemradio"][data-state="checked"]'
            : '[role="menuitem"]',
        )
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [themeChooser, menuOpen]);
  async function saveTheme(value: string) {
    if (themeSaving.current) return;
    themeSaving.current = true;
    setThemeBusy(true);
    setLocalError("");
    try {
      const snapshot = await invoke<{ preferences: DesktopPreferences }>(
        "desktop_preferences_save",
        {
          preferences: { pomodoroTheme: readPomodoroTheme(value) },
        },
      );
      if (alive.current)
        setTheme(readPomodoroTheme(snapshot.preferences.pomodoroTheme));
    } catch (cause) {
      if (alive.current) setLocalError(String(cause));
    } finally {
      themeSaving.current = false;
      if (alive.current) setThemeBusy(false);
    }
  }
  useEffect(() => {
    const stops = [
      listen<string>("pomodoro-widget-error", (event) =>
        setLocalError(event.payload),
      ),
      listen("pomodoro-widget-dismissed", () => {
        setControlsOpen(false);
        setMenuOpen(false);
        setThemeChooser(false);
        setDragging(false);
      }),
      listen<{ right: boolean; bottom: boolean }>(
        "pomodoro-widget-anchor",
        (event) => setAnchor(event.payload),
      ),
      listen<{ inside: boolean }>("pomodoro-widget-drag-ended", () =>
        setDragging(false),
      ),
    ];
    return () => {
      stops.forEach(
        (stop) => void stop.then((dispose) => dispose()).catch(() => {}),
      );
    };
  }, []);
  useEffect(() => {
    const node = strip.current;
    if (!node) return;
    let previous = "";
    const update = () => {
      const width = Math.ceil(node.getBoundingClientRect().width) + 16;
      const height = Math.ceil(node.getBoundingClientRect().height) + 16;
      const key = `${width}:${height}:${menuOpen}`;
      if (previous === key) return;
      previous = key;
      void invoke("pomodoro_widget_layout", { width, height, menuOpen }).catch(
        (cause) => setLocalError(String(cause)),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, menuOpen]);
  const primary = data ? primaryPomodoroAction(data) : null;
  const status = data ? pomodoroStatus(data, true) : "读取中";
  const fail = (cause: unknown) =>
    setLocalError(cause instanceof Error ? cause.message : String(cause));
  const openPage = () => {
    setLocalError("");
    void invoke("desktop_main", { page: "pomodoro" }).catch(fail);
  };
  async function act(action: Parameters<typeof pomodoroAction>[0]) {
    setLocalError("");
    try {
      await pomodoroAction(action);
    } catch {
      /* The clock exposes failed actions through the error control. */
    }
  }
  function down(event: PointerEvent<HTMLElement>) {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      (event.target as Element).closest("button")
    )
      return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      pointer: event.pointerId,
    };
    setLocalError("");
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const gesture = drag.current;
    if (!(event.buttons & 1)) {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (
      !gesture ||
      gesture.pointer !== event.pointerId ||
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5
    )
      return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(true);
    void invoke<boolean>("pomodoro_widget_drag")
      .then((started) => {
        if (!started) setDragging(false);
      })
      .catch((cause) => {
        setDragging(false);
        fail(cause);
      });
  }
  return (
    <main
      className="pomodoro-widget-frame"
      data-anchor-right={anchor.right}
      data-anchor-bottom={anchor.bottom}
    >
      <ContextMenu.Root
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setThemeChooser(false);
        }}
      >
        <ContextMenu.Trigger asChild>
          <section
            ref={strip}
            className="pomodoro-widget"
            aria-label="桌面番茄钟"
            data-status={data?.status}
            data-expanded={expanded}
            data-dragging={dragging}
            onKeyDown={(event) => {
              if (event.key === "Escape")
                void invoke("desktop_dismiss").catch(fail);
            }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <div
              className="pomodoro-widget-drag"
              tabIndex={0}
              aria-label={`${status}，${data ? formatCountdown(remaining) : "正在读取"}`}
              onKeyDown={(event) => {
                if (event.key === "Enter") openPage();
              }}
            >
              <span>{status}</span>
              <strong role="timer" aria-live="off">
                {data ? formatCountdown(remaining) : "--:--"}
              </strong>
            </div>
            {(localError || error) && (
              <Hint
                side="bottom"
                label={
                  <>
                    {localError || error}
                    <br />
                    重新读取计时状态
                  </>
                }
              >
                <button
                  className="pomodoro-widget-error"
                  aria-label="重新读取番茄钟状态"
                  onClick={() => {
                    setLocalError("");
                    void refresh();
                  }}
                >
                  <CircleAlert size={14} />
                </button>
              </Hint>
            )}
            <button
              className="pomodoro-widget-toggle"
              aria-label={expanded ? "收起计时操作" : "展开计时操作"}
              aria-expanded={expanded}
              onClick={() => setControlsOpen((value) => !value)}
            >
              {expanded ? (
                <ChevronLeft size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </button>
            {expanded && (
              <div
                className="pomodoro-widget-actions"
                role="group"
                aria-label="计时操作"
              >
                <span className="pomodoro-widget-divider" aria-hidden="true" />
                <button
                  className="pomodoro-widget-primary"
                  aria-label={primary?.label || "正在读取"}
                  disabled={busy || !primary}
                  onClick={() => {
                    if (primary) void act(primary.action);
                  }}
                >
                  {primary?.action === "pause" ? (
                    <Pause size={14} fill="currentColor" strokeWidth={0} />
                  ) : (
                    <Play size={14} fill="currentColor" strokeWidth={0} />
                  )}
                </button>
                {data?.phase !== "idle" && data && (
                  <button
                    aria-label="结束本轮"
                    disabled={busy}
                    onClick={() => void act("end")}
                  >
                    <Square size={11} fill="currentColor" strokeWidth={0} />
                  </button>
                )}
                <button aria-label="打开番茄钟" onClick={openPage}>
                  <ArrowUpRight size={15} />
                </button>
              </div>
            )}
          </section>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            ref={contextMenu}
            className="pomodoro-widget-menu"
            collisionPadding={8}
          >
            {themeChooser ? (
              <>
                <ContextMenu.Item
                  className="pomodoro-theme-back"
                  onSelect={(event) => {
                    event.preventDefault();
                    setThemeChooser(false);
                  }}
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                  主题颜色
                </ContextMenu.Item>
                <ContextMenu.RadioGroup
                  className="pomodoro-theme-options"
                  value={theme}
                  onValueChange={(value) => void saveTheme(value)}
                >
                  {pomodoroThemes.map((option) => (
                    <ContextMenu.RadioItem
                      key={option.value}
                      value={option.value}
                      disabled={themeBusy}
                    >
                      <span
                        className="pomodoro-theme-swatch"
                        data-theme={option.value}
                        aria-hidden="true"
                      />
                      <span>{option.label}</span>
                      <ContextMenu.ItemIndicator className="pomodoro-theme-check">
                        <Check size={12} />
                      </ContextMenu.ItemIndicator>
                    </ContextMenu.RadioItem>
                  ))}
                </ContextMenu.RadioGroup>
              </>
            ) : (
              <>
                <ContextMenu.Item
                  disabled={!themeReady || themeBusy}
                  onSelect={(event) => {
                    event.preventDefault();
                    setThemeChooser(true);
                  }}
                >
                  主题颜色
                </ContextMenu.Item>
                <ContextMenu.Item
                  onSelect={() => {
                    setLocalError("");
                    void invoke("pomodoro_widget_reset").catch(fail);
                  }}
                >
                  返回默认位置
                </ContextMenu.Item>
                <ContextMenu.Item onSelect={openPage}>
                  打开番茄钟
                </ContextMenu.Item>
                <ContextMenu.Item
                  onSelect={() => void invoke("desktop_dismiss").catch(fail)}
                >
                  收起桌面番茄钟
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </main>
  );
}
