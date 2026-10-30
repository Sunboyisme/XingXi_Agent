import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { DropdownMenu } from "radix-ui";
import {
  ArrowLeftRight,
  ArrowUpDown,
  Check,
  ChevronRight,
  Circle,
  ClipboardPaste,
  Contrast,
  Copy,
  Download,
  FolderOpen,
  Image as ImageIcon,
  Layers2,
  Pencil,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Trash2,
  X,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import { invoke, desktopError } from "@/lib/desktopAssistant";
import { useDesktopHitRegions } from "@/lib/desktopHitRegions";
import { pinZoomLevels, type PinMenuSession } from "@/lib/pinnedImage";
import "../styles/pinned-context-menu.css";

function refreshMenuRegions(node: HTMLDivElement | null) {
  if (node)
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}

function Item({
  action,
  children,
  icon: Icon,
  shortcut,
  checked,
  disabled,
  danger,
  onAction,
}: {
  action: string;
  children: ReactNode;
  icon?: LucideIcon;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onAction: (action: string) => void;
}) {
  return (
    <DropdownMenu.Item
      className={`pin-menu-item ${danger ? "is-danger" : ""}`}
      disabled={disabled}
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      onSelect={(event) => {
        event.preventDefault();
        onAction(action);
      }}
    >
      <span className="pin-menu-icon" aria-hidden="true">
        {checked ? (
          <Check size={15} />
        ) : Icon ? (
          <Icon size={15} strokeWidth={1.6} />
        ) : null}
      </span>
      <span className="pin-menu-label">{children}</span>
      {shortcut && <span className="pin-menu-key">{shortcut}</span>}
    </DropdownMenu.Item>
  );
}
function Submenu({
  label,
  icon: Icon,
  disabled,
  children,
}: {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="pin-menu-item" disabled={disabled}>
        <span className="pin-menu-icon" aria-hidden="true">
          <Icon size={15} strokeWidth={1.6} />
        </span>
        <span className="pin-menu-label">{label}</span>
        <ChevronRight
          className="pin-menu-chevron"
          size={13}
          aria-hidden="true"
        />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          className="pin-context-submenu"
          ref={refreshMenuRegions}
          sideOffset={5}
          collisionPadding={10}
          aria-label={label}
        >
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
const Separator = () => (
  <DropdownMenu.Separator className="pin-menu-separator" />
);

export function PinnedContextMenu() {
  const [session, setSession] = useState<PinMenuSession | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(session);
  current.current = session;
  const alive = useRef(false);
  const actionLock = useRef(false);
  useDesktopHitRegions(".pin-context-menu,.pin-context-submenu");
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let version = 0;
    const opened = listen<PinMenuSession>("pinned-menu-open", (event) => {
      version++;
      if (!disposed) {
        current.current = event.payload;
        setSession(event.payload);
        setSending(false);
        actionLock.current = false;
        setError("");
      }
    });
    const closed = listen<string>("pinned-menu-closed", (event) => {
      version++;
      if (!disposed && current.current?.requestId === event.payload) {
        current.current = null;
        setSession(null);
      }
    });
    void Promise.all([opened, closed])
      .then(async () => {
        const requestedAt = version;
        const value = await invoke<PinMenuSession | null>("pinned_menu_get");
        if (!disposed && requestedAt === version) {
          current.current = value;
          setSession(value);
        }
      })
      .catch((e) => {
        if (!disposed) setError(desktopError(e));
      });
    return () => {
      disposed = true;
      alive.current = false;
      void Promise.all([opened, closed])
        .then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()))
        .catch(() => {});
    };
  }, []);
  async function close(restoreFocus = false) {
    const value = current.current;
    if (!value) return;
    try {
      await invoke("pinned_menu_close", {
        requestId: value.requestId,
        restoreFocus,
      });
      if (alive.current && current.current?.requestId === value.requestId) {
        current.current = null;
        setSession(null);
      }
    } catch (e) {
      if (alive.current) setError(desktopError(e));
    }
  }
  function select(action: string) {
    const value = current.current;
    if (!value || actionLock.current) return;
    actionLock.current = true;
    setSending(true);
    setError("");
    void invoke("pinned_menu_action", { requestId: value.requestId, action })
      .catch((e) => {
        if (alive.current && current.current?.requestId === value.requestId)
          setError(desktopError(e));
      })
      .finally(() => {
        if (alive.current && current.current?.requestId === value.requestId) {
          actionLock.current = false;
          setSending(false);
        }
      });
  }
  if (!session) return null;
  const disabled = session.busy || sending;
  const viewDisabled = disabled || session.editing;
  const zoomChoices = (
    <>
      {pinZoomLevels.map((value) => (
        <Item
          key={value}
          action={`zoom:${value}`}
          checked={Math.abs(session.scale - value) < 0.005}
          disabled={viewDisabled}
          onAction={select}
        >
          {Math.round(value * 100)}%
        </Item>
      ))}
      <Separator />
      <Item
        action="zoom:0"
        icon={ImageIcon}
        disabled={viewDisabled}
        onAction={select}
      >
        适应屏幕
      </Item>
    </>
  );
  return (
    <main
      className="pin-menu-host"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        const key = event.key.toLowerCase();
        const action =
          key === "c"
            ? event.shiftKey
              ? "copy-original"
              : "copy"
            : key === "s"
              ? "save"
              : key === "v"
                ? "paste"
                : key === "0"
                  ? "zoom:1"
                  : "";
        if (!action) return;
        event.preventDefault();
        if (disabled || (viewDisabled && (key === "v" || key === "0"))) return;
        select(action);
      }}
    >
      <DropdownMenu.Root
        open
        modal={false}
        onOpenChange={(open) => {
          if (!open) void close();
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="pin-context-anchor"
            style={{ left: session.anchorX, top: session.anchorY }}
            aria-label="贴图菜单"
            tabIndex={-1}
          />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            key={session.requestId}
            className={`pin-context-menu ${session.zoomOnly ? "is-zoom-only" : ""}`}
            side="bottom"
            align="start"
            sideOffset={0}
            collisionPadding={10}
            ref={refreshMenuRegions}
            aria-label={session.zoomOnly ? "贴图缩放" : "贴图操作"}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              void close(true);
            }}
          >
            <DropdownMenu.Label className="pin-menu-heading">
              <span>{session.zoomOnly ? "缩放" : "贴图"}</span>
              <span>{Math.round(session.scale * 100)}%</span>
            </DropdownMenu.Label>
            {session.zoomOnly ? (
              zoomChoices
            ) : (
              <>
                <DropdownMenu.Group>
                  <Item
                    action="copy"
                    icon={Copy}
                    shortcut="Ctrl+C"
                    disabled={disabled}
                    onAction={select}
                  >
                    复制图像
                  </Item>
                  <Item
                    action="copy-original"
                    icon={ImageIcon}
                    shortcut="Ctrl+Shift+C"
                    disabled={disabled}
                    onAction={select}
                  >
                    复制原始大小图像
                  </Item>
                  <Item
                    action="save"
                    icon={Download}
                    shortcut="Ctrl+S"
                    disabled={disabled}
                    onAction={select}
                  >
                    另存为…
                  </Item>
                </DropdownMenu.Group>
                <Separator />
                <Item
                  action="annotate"
                  icon={Pencil}
                  disabled={disabled}
                  onAction={select}
                >
                  {session.editing ? "完成标注" : "标注"}
                </Item>
                <Item
                  action="shadow"
                  icon={Layers2}
                  checked={session.shadow}
                  disabled={disabled}
                  onAction={select}
                >
                  窗口阴影
                </Item>
                <Submenu label="缩放" icon={ZoomIn} disabled={viewDisabled}>
                  {zoomChoices}
                </Submenu>
                <Submenu
                  label="图像处理"
                  icon={SlidersHorizontal}
                  disabled={viewDisabled}
                >
                  <Item action="rotate-left" icon={RotateCcw} onAction={select}>
                    向左旋转 90°
                  </Item>
                  <Item action="rotate-right" icon={RotateCw} onAction={select}>
                    向右旋转 90°
                  </Item>
                  <Item action="flip-x" icon={ArrowLeftRight} onAction={select}>
                    水平翻转
                  </Item>
                  <Item action="flip-y" icon={ArrowUpDown} onAction={select}>
                    垂直翻转
                  </Item>
                  <Separator />
                  <Item action="grayscale" icon={Circle} onAction={select}>
                    灰度
                  </Item>
                  <Item action="invert" icon={Contrast} onAction={select}>
                    反色
                  </Item>
                  <Item action="reset-image" icon={RotateCcw} onAction={select}>
                    还原图像
                  </Item>
                </Submenu>
                <Submenu label="透明度" icon={Circle} disabled={disabled}>
                  {[1, 0.9, 0.75, 0.5, 0.25, 0.15].map((value) => (
                    <Item
                      key={value}
                      action={`opacity:${value}`}
                      checked={session.opacity === value}
                      onAction={select}
                    >
                      {Math.round(value * 100)}%
                    </Item>
                  ))}
                </Submenu>
                <Separator />
                <Item
                  action="paste"
                  icon={ClipboardPaste}
                  shortcut="Ctrl+V"
                  disabled={viewDisabled}
                  onAction={select}
                >
                  粘贴
                </Item>
                <Item
                  action="replace"
                  icon={FolderOpen}
                  disabled={viewDisabled}
                  onAction={select}
                >
                  从文件替换…
                </Item>
                <Separator />
                <Item
                  action="close"
                  icon={X}
                  shortcut="Esc"
                  disabled={sending}
                  onAction={select}
                >
                  关闭贴图
                </Item>
                <Item
                  action="destroy"
                  icon={Trash2}
                  danger
                  disabled={sending}
                  onAction={select}
                >
                  销毁贴图
                </Item>
                <Separator />
                <DropdownMenu.Item
                  className="pin-menu-size"
                  disabled={disabled}
                  aria-label="复制图像尺寸"
                  onSelect={(event) => {
                    event.preventDefault();
                    select("copy-size");
                  }}
                >
                  <span>
                    {session.width} × {session.height}{" "}
                    <span className="pin-menu-px">px</span>
                  </span>
                  <span>复制尺寸</span>
                </DropdownMenu.Item>
              </>
            )}
            {error && (
              <p className="pin-menu-error" role="alert">
                {error}
              </p>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </main>
  );
}
