import { Hint } from "./common";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import {
  Bell,
  Copy,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Square,
  X,
} from "lucide-react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppMenu, type AppMenuActions } from "./AppMenu";

export function WindowFrame({
  children,
  collapsed,
  onToggle,
  onReminders,
  unread = 0,
  reminder = false,
  sidebarAvailable = true,
  sidebarLabel = "侧栏",
  sidebarControls = "chat-sidebar",
  menuActions,
}: {
  children: ReactNode;
  collapsed: boolean;
  onToggle?: () => void;
  onReminders?: () => void;
  unread?: number;
  reminder?: boolean;
  sidebarAvailable?: boolean;
  sidebarLabel?: string;
  sidebarControls?: string;
  menuActions?: AppMenuActions;
}) {
  const native = isTauri();
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState("");
  const handleSidebarShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      reminder || !sidebarAvailable || !onToggle || event.defaultPrevented ||
      event.isComposing || !event.altKey || event.ctrlKey || event.metaKey ||
      event.shiftKey || (event.key !== "1" && event.code !== "Digit1") ||
      document.querySelector('[role="dialog"], [role="alertdialog"]')
    ) return;
    event.preventDefault();
    if (!event.repeat) onToggle();
  });
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => handleSidebarShortcut(event);
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    if (!native || reminder) return;
    let active = true;
    const window = getCurrentWindow();
    const sync = () =>
      window
        .isMaximized()
        .then((value) => {
          if (active) setMaximized(value);
        })
        .catch(() => {});
    void sync();
    const stop = window.onResized(() => void sync());
    return () => {
      active = false;
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [native, reminder]);
  useEffect(() => {
    if (native && !reminder) {
      void invoke("ensure_window_visible").catch(() =>
        setError("窗口适配未完成，可从视图菜单重试。"),
      );
    }
  }, [native, reminder]);

  async function control(action: () => Promise<void>) {
    try {
      setError("");
      await action();
    } catch {
      setError("窗口操作未完成，请重试。");
    }
  }
  if (reminder) return children;
  return (
    <div className="window-frame">
      <header className="window-titlebar app-topbar" data-tauri-drag-region>
        <span className="window-brand" data-tauri-drag-region>
          XiaoXi
        </span>
        {sidebarAvailable && onToggle && (
          <div className="window-sidebar-control">
            <Hint label={`${collapsed ? "展开" : "收起"}${sidebarLabel}（Alt+1）`}>
              <button
                className="sidebar-toggle"
                aria-label={`${collapsed ? "展开" : "收起"}${sidebarLabel}`}
                aria-expanded={!collapsed}
                aria-controls={sidebarControls}
                aria-keyshortcuts="Alt+1"
                onClick={onToggle}
              >
                {collapsed ? (
                  <PanelLeftOpen size={18} />
                ) : (
                  <PanelLeftClose size={18} />
                )}
              </button>
            </Hint>
          </div>
        )}
        {menuActions && (
          <AppMenu
            actions={menuActions}
            collapsed={collapsed}
            onToggle={sidebarAvailable ? onToggle : undefined}
            sidebarLabel={sidebarLabel}
            onFitWindow={
              native
                ? () => void control(() => invoke("restore_window_layout"))
                : undefined
            }
            onClose={
              native
                ? () => void control(() => getCurrentWindow().close())
                : undefined
            }
            onQuit={
              native ? () => void control(() => invoke("quit_app")) : undefined
            }
            onError={setError}
          />
        )}
        {import.meta.env.DEV && <small className="preview-label">测试版</small>}
        <div className="window-drag-space" data-tauri-drag-region />
        {onReminders && (
          <button
            className="bell-button"
            aria-label="查看通知"
            onClick={onReminders}
          >
            <Bell size={17} />
            {unread > 0 && <span />}
          </button>
        )}
        {native && (
          <div className="window-controls">
            <Hint label="最小化">
              <button
                aria-label="最小化"
                onClick={() =>
                  void control(() => getCurrentWindow().minimize())
                }
              >
                <Minus size={15} />
              </button>
            </Hint>
            <Hint label={maximized ? "还原窗口" : "最大化"}>
              <button
                aria-label={maximized ? "还原窗口" : "最大化"}
                onClick={() =>
                  void control(() => getCurrentWindow().toggleMaximize())
                }
              >
                {maximized ? <Copy size={13} /> : <Square size={13} />}
              </button>
            </Hint>
            <Hint label="关闭窗口">
              <button
                className="window-close"
                aria-label="关闭窗口"
                onClick={() => void control(() => getCurrentWindow().close())}
              >
                <X size={17} />
              </button>
            </Hint>
          </div>
        )}
      </header>
      {error && (
        <div className="window-control-error" role="alert">
          {error}
        </div>
      )}
      {children}
    </div>
  );
}
