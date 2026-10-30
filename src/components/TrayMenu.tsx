import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AppWindow,
  CalendarDays,
  Check,
  LogOut,
  MessageSquarePlus,
  Power,
  Settings,
  Smile,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { Hint } from "./ui/hint";
import "../styles/tray-menu.css";

type TrayState = {
  generation: number;
  active: boolean;
  pet: boolean;
  preview: boolean;
  autostart: { enabled: boolean; supported: boolean; reason: string };
};
type Action =
  | "show"
  | "new_chat"
  | "plans"
  | "pomodoro"
  | "pomodoro_widget"
  | "pet"
  | "autostart"
  | "settings"
  | "quit";

export function TrayMenu() {
  const [state, setState] = useState<TrayState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const lock = useRef(false);
  const request = useRef(0);
  const menu = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const value = await invoke<TrayState>("tray_menu_state");
      if (mounted.current && sequence === request.current) setState(value);
    } catch (cause) {
      if (mounted.current && sequence === request.current)
        setError(String(cause));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const listeners = [
      listen("tray-menu-open", () => {
        setError("");
        void refresh();
      }),
      listen("desktop-preferences", () => void refresh()),
      listen("autostart-changed", () => void refresh()),
    ];
    void Promise.all(listeners)
      .then(refresh)
      .catch((cause) => {
        if (mounted.current) setError(String(cause));
      });
    return () => {
      mounted.current = false;
      request.current++;
      listeners.forEach(
        (stop) => void stop.then((dispose) => dispose()).catch(() => {}),
      );
    };
  }, [refresh]);
  useEffect(() => {
    if (!state?.active) return;
    const frame = requestAnimationFrame(() =>
      menu.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [state?.generation, state?.active]);
  async function act(action: Action, enabled?: boolean) {
    if (!state || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await invoke("tray_menu_action", {
        generation: state.generation,
        action,
        enabled,
      });
      await refresh();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function item(
    action: Action,
    label: string,
    Icon: LucideIcon,
    checked?: boolean,
    unavailable?: string,
  ) {
    const button = (
      <button
        type="button"
        className={`tray-row ${action === "quit" ? "is-quit" : ""}`}
        role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={checked}
        aria-disabled={busy || Boolean(unavailable)}
        disabled={!state?.active}
        onClick={() => {
          if (!unavailable && !busy)
            void act(action, checked === undefined ? undefined : !checked);
        }}
      >
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
        {unavailable ? (
          <small>{state?.preview ? "仅安装版" : "不可用"}</small>
        ) : checked ? (
          <Check size={14} className="tray-check" aria-hidden="true" />
        ) : null}
      </button>
    );
    return unavailable ? (
      <Hint label={unavailable} side="left">
        {button}
      </Hint>
    ) : (
      button
    );
  }
  return (
    <div
      className="tray-frame"
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget)
          void invoke("tray_menu_close", {
            generation: state?.generation || 0,
          }).catch(() => {});
      }}
    >
      <div
        className="tray-popup"
        ref={menu}
        role="menu"
        aria-busy={busy}
        aria-label="XiaoXi托盘菜单"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            void invoke("tray_menu_close", {
              generation: state?.generation || 0,
            }).catch(() => {});
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const buttons = [
            ...(menu.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ) || []),
          ];
          if (!buttons.length) return;
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          buttons[next].focus();
        }}
      >
        <header className="tray-heading">
          <strong>XiaoXi</strong>
          {state?.preview && <span>测试版</span>}
        </header>
        {item("show", "打开主窗口", AppWindow)}
        {item("new_chat", "新建对话", MessageSquarePlus)}
        {item("plans", "打开今日安排", CalendarDays)}
        <hr />
        {item("pomodoro", "打开番茄钟", Timer)}
        {item("pomodoro_widget", "显示桌面番茄钟", Timer)}
        {item("pet", "显示桌面宠物", Smile, state?.pet || false)}
        {item(
          "autostart",
          "开机自启",
          Power,
          state?.autostart.enabled || false,
          state && !state.autostart.supported
            ? state.autostart.reason
            : undefined,
        )}
        <hr />
        {item("settings", "连接与设置", Settings)}
        {item("quit", "退出XiaoXi", LogOut)}
        {error && (
          <p className="tray-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
