import { useRef, type ReactNode } from "react";
import { Menubar } from "radix-ui";

export type AppMenuActions = {
  newChat: () => void;
  newLearning: () => void;
  newPlan: () => void;
  navigate: (page: string) => void;
  about: () => void;
  shortcuts: () => void;
};

type Editor = HTMLInputElement | HTMLTextAreaElement;
type Selection = { element: Editor; start: number; end: number };

export function AppMenu({
  actions,
  collapsed,
  sidebarLabel = "侧栏",
  onToggle,
  onFitWindow,
  onClose,
  onQuit,
  onError,
}: {
  actions: AppMenuActions;
  collapsed: boolean;
  sidebarLabel?: string;
  onToggle?: () => void;
  onFitWindow?: () => void;
  onClose?: () => void;
  onQuit?: () => void;
  onError: (message: string) => void;
}) {
  const editor = useRef<Selection | null>(null);
  const pending = useRef<(() => void) | null>(null);

  function captureEditor() {
    const element = document.activeElement;
    if (
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement) &&
      element.selectionStart !== null
    ) {
      editor.current = {
        element,
        start: element.selectionStart,
        end: element.selectionEnd ?? element.selectionStart,
      };
    } else if (!editor.current?.element.isConnected) {
      editor.current = null;
    }
  }
  async function edit(command: string) {
    const selection = editor.current;
    if (!selection?.element.isConnected) {
      onError("请先选中要编辑的输入框或文字。");
      return;
    }
    const { element, start, end } = selection;
    element.focus();
    element.setSelectionRange(start, end);
    try {
      if (command === "paste") {
        const text = await navigator.clipboard.readText();
        element.focus();
        element.setSelectionRange(start, end);
        if (!document.execCommand("insertText", false, text)) throw new Error();
      } else {
        document.execCommand(command);
      }
      onError("");
    } catch {
      onError("剪贴板操作未完成，请使用 Ctrl+C、Ctrl+X 或 Ctrl+V。");
    }
  }
  function item(
    label: string,
    action: () => void,
    shortcut?: string,
    disabled = false,
  ) {
    return (
      <Menubar.Item
        key={label}
        className="app-menu-item"
        disabled={disabled}
        onSelect={() => {
          pending.current = action;
        }}
      >
        <span>{label}</span>
        {shortcut && <kbd>{shortcut}</kbd>}
      </Menubar.Item>
    );
  }
  function group(label: string, children: ReactNode) {
    return (
      <Menubar.Menu key={label}>
        <Menubar.Trigger className="app-menu-trigger">{label}</Menubar.Trigger>
        <Menubar.Portal>
          <Menubar.Content
            className="app-menu-content"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              const action = pending.current;
              pending.current = null;
              if (action) {
                event.preventDefault();
                action();
              }
            }}
          >
            {children}
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>
    );
  }
  return (
    <Menubar.Root
      className="app-menubar"
      aria-label="应用菜单"
      onPointerDownCapture={captureEditor}
      onKeyDownCapture={(event) => {
        if (event.target === event.currentTarget) captureEditor();
      }}
    >
      {group(
        "文件",
        <>
          {item("新建对话", actions.newChat, "Ctrl+N")}
          {item("新建学习目标", actions.newLearning)}
          {item("新建计划", actions.newPlan)}
          <Menubar.Separator className="app-menu-separator" />
          {item("连接与设置", () => actions.navigate("settings"), "Ctrl+,")}
          {onClose && (
            <>
              <Menubar.Separator className="app-menu-separator" />
              {item("关闭窗口", onClose)}
            </>
          )}
          {onQuit && item("退出XiaoXi", onQuit)}
        </>,
      )}
      {group(
        "编辑",
        <>
          {item("撤销", () => void edit("undo"), "Ctrl+Z")}
          {item("重做", () => void edit("redo"), "Ctrl+Y")}
          <Menubar.Separator className="app-menu-separator" />
          {item("剪切", () => void edit("cut"), "Ctrl+X")}
          {item("复制", () => void edit("copy"), "Ctrl+C")}
          {item("粘贴", () => void edit("paste"), "Ctrl+V")}
          {item("全选", () => void edit("selectAll"), "Ctrl+A")}
          <Menubar.Separator className="app-menu-separator" />
          {item("编辑记忆", () => actions.navigate("memories"))}
        </>,
      )}
      {group(
        "视图",
        <>
          {item("对话", () => actions.navigate("chat"), "Ctrl+1")}
          {item("学习", () => actions.navigate("learning"), "Ctrl+2")}
          {item("计划", () => actions.navigate("plans"), "Ctrl+3")}
          {(onToggle || onFitWindow) && <Menubar.Separator className="app-menu-separator" />}
          {onToggle && item(`${collapsed ? "显示" : "隐藏"}${sidebarLabel}`, onToggle)}
          {onFitWindow && item("适配窗口到屏幕", onFitWindow)}
        </>,
      )}
      {group(
        "帮助",
        <>
          {item("快捷键", actions.shortcuts, "F1")}
          {item("关于 XiaoXi", actions.about)}
        </>,
      )}
    </Menubar.Root>
  );
}
