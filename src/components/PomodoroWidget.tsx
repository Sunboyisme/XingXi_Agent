import { useEffect, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ContextMenu } from "radix-ui";
import { ArrowUpRight, CircleAlert, Pause, Play, Square } from "lucide-react";
import { Hint } from "./common";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
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
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const expanded = hovered || focused || menuOpen || dragging;
  useDesktopHitRegions(
    ".pomodoro-widget,.pomodoro-widget-menu,.ui-hint,.ui-hint-arrow",
    true,
  );
  useEffect(() => {
    const stops = [
      listen<string>("pomodoro-widget-error", (event) =>
        setLocalError(event.payload),
      ),
      listen("pomodoro-widget-dismissed", () => {
        setHovered(false);
        setFocused(false);
        setMenuOpen(false);
        setDragging(false);
      }),
      listen<boolean>("pomodoro-widget-pointer", (event) =>
        setHovered(event.payload),
      ),
      listen<{ inside: boolean }>("pomodoro-widget-drag-ended", (event) => {
        setDragging(false);
        setHovered(event.payload.inside);
      }),
    ];
    return () => {
      stops.forEach(
        (stop) => void stop.then((dispose) => dispose()).catch(() => {}),
      );
    };
  }, []);
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
    setFocused(false);
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
    <main className="pomodoro-widget-frame">
      <ContextMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <ContextMenu.Trigger asChild>
          <section
            className="pomodoro-widget"
            aria-label="桌面番茄钟"
            data-status={data?.status}
            data-expanded={expanded}
            data-dragging={dragging}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onFocusCapture={(event) =>
              setFocused(event.target.matches(":focus-visible"))
            }
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setFocused(false);
            }}
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
                    <Pause size={14} />
                  ) : (
                    <Play size={14} />
                  )}
                </button>
                {data?.phase !== "idle" && data && (
                  <button
                    aria-label="结束本轮"
                    disabled={busy}
                    onClick={() => void act("end")}
                  >
                    <Square size={12} />
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
            className="pomodoro-widget-menu"
            collisionPadding={8}
          >
            <ContextMenu.Item
              onSelect={() => {
                setLocalError("");
                void invoke("pomodoro_widget_reset").catch(fail);
              }}
            >
              返回默认位置
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={openPage}>打开番茄钟</ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </main>
  );
}
