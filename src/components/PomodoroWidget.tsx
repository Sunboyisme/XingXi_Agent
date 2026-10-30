import { useEffect, useRef, useState, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ContextMenu } from "radix-ui";
import {
  ArrowUpRight,
  CircleAlert,
  GripVertical,
  Pause,
  Play,
  Square,
} from "lucide-react";
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
  const { data, remaining, busy, error } = usePomodoro();
  const [localError, setLocalError] = useState("");
  const drag = useRef<{ x: number; y: number; pointer: number } | null>(null);
  useDesktopHitRegions(".pomodoro-widget,.pomodoro-widget-menu,.ui-hint");
  useEffect(() => {
    const stop = listen<string>("pomodoro-widget-error", (event) =>
      setLocalError(event.payload),
    );
    return () => {
      void stop.then((dispose) => dispose()).catch(() => {});
    };
  }, []);
  const primary = data ? primaryPomodoroAction(data) : null;
  const status = !data
    ? "读取中"
    : data.status === "paused"
      ? "已暂停"
      : {
          idle: "待开始",
          focus: "专注",
          break: "休息",
          waiting_break: "待休息",
          waiting_focus: "待开始",
        }[data.phase];
  const fail = (cause: unknown) =>
    setLocalError(cause instanceof Error ? cause.message : String(cause));
  const openPage = () =>
    void invoke("desktop_main", { page: "pomodoro" }).catch(fail);
  async function act(action: Parameters<typeof pomodoroAction>[0]) {
    setLocalError("");
    try {
      await pomodoroAction(action, data?.session?.title || "");
    } catch {
      /* The same clock exposes the failed action through its inline Hint. */
    }
  }
  function down(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as Element).closest("button"))
      return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      pointer: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const gesture = drag.current;
    if (
      !gesture ||
      gesture.pointer !== event.pointerId ||
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5
    )
      return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    void invoke("pomodoro_widget_drag").catch(fail);
  }
  return (
    <main className="pomodoro-widget-frame">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <section
            className="pomodoro-widget"
            aria-label="桌面番茄钟"
            data-status={data?.status}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          >
            <Hint
              side="bottom"
              label={
                <>
                  {data ? pomodoroStatus(data) : "读取番茄钟"}
                  {data?.session?.title && (
                    <>
                      <br />
                      {data.session.title}
                    </>
                  )}
                  <br />
                  按住拖动，右键可回到桌宠头顶
                </>
              }
            >
              <div
                className="pomodoro-widget-drag"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter") openPage();
                }}
              >
                <GripVertical size={12} aria-hidden="true" />
                <span>{status}</span>
                <strong role="timer" aria-live="off">
                  {data ? formatCountdown(remaining) : "--:--"}
                </strong>
              </div>
            </Hint>
            {(localError || error) && (
              <Hint side="bottom" label={localError || error}>
                <button
                  className="pomodoro-widget-error"
                  aria-label={localError || error}
                >
                  <CircleAlert size={14} />
                </button>
              </Hint>
            )}
            <span className="pomodoro-widget-divider" aria-hidden="true" />
            <Hint side="bottom" label={primary?.label || "正在读取"}>
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
            </Hint>
            {data?.phase !== "idle" && data && (
              <Hint side="bottom" label="结束本轮，保留已专注时长">
                <button
                  aria-label="结束本轮"
                  disabled={busy}
                  onClick={() => void act("end")}
                >
                  <Square size={12} />
                </button>
              </Hint>
            )}
            <Hint side="bottom" label="打开番茄钟">
              <button aria-label="打开番茄钟" onClick={openPage}>
                <ArrowUpRight size={15} />
              </button>
            </Hint>
          </section>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className="pomodoro-widget-menu"
            collisionPadding={8}
          >
            <ContextMenu.Item
              onSelect={() => void invoke("pomodoro_widget_reset").catch(fail)}
            >
              回到桌宠头顶
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={openPage}>打开番茄钟</ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </main>
  );
}
