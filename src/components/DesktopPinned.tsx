import { useEffect, useRef, useState, type PointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import {
  ArrowUpRight,
  Check,
  Circle,
  Grid2X2,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Hint } from "./common";
import { desktopError, invoke } from "@/lib/desktopAssistant";
import {
  paintCaptureMark,
  type CaptureMark,
  type CapturePoint,
  type CaptureTool,
} from "@/lib/captureDrawing";
import {
  loadPinCanvas,
  pinMenuItems,
  type PinGeometry,
  type PinInfo,
} from "@/lib/pinnedImage";
import { processPinImage } from "@/lib/pinnedImage";
import "../styles/pinned-image.css";

const tools = [
  ["pen", "画笔", Pencil],
  ["arrow", "箭头", ArrowUpRight],
  ["rect", "矩形", Square],
  ["ellipse", "椭圆", Circle],
  ["text", "文字", Type],
  ["mosaic", "马赛克", Grid2X2],
] as const;

export function DesktopPinned() {
  const [info, setInfo] = useState<PinInfo | null>(null);
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [shadow, setShadow] = useState(true);
  const [opacity, setOpacity] = useState(1);
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<CaptureTool>("pen");
  const [color, setColor] = useState("#ef4444");
  const [width, setWidth] = useState(3);
  const [fontSize, setFontSize] = useState(24);
  const [text, setText] = useState("");
  const [marks, setMarks] = useState<CaptureMark[]>([]);
  const [redo, setRedo] = useState<CaptureMark[]>([]);
  const [live, setLive] = useState<CaptureMark | null>(null);
  const root = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef(info);
  current.current = info;
  const mounted = useRef(false);
  const locked = useRef(false);
  const drawing = useRef<{ pointer: number; mark: CaptureMark } | null>(null);
  const menu = useRef<Menu | null>(null);
  const menuOpening = useRef(false);
  const zooming = useRef(false);
  const zoomTarget = useRef({ scale: 1, x: 0.5, y: 0.5 });
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const actions = useRef({ dispatch, requestZoom, syncDpi, undo, redoMark });
  actions.current = { dispatch, requestZoom, syncDpi, undo, redoMark };

  function accept(next: PinInfo) {
    if (current.current?.dataUrl !== next.dataUrl) setSource(null);
    current.current = next;
    zoomTarget.current.scale = next.scale;
    setInfo(next);
    setMarks([]);
    setRedo([]);
    setLive(null);
    setEditing(false);
    drawing.current = null;
  }
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    void invoke<PinInfo>("pinned_info")
      .then((value) => {
        if (alive) accept(value);
      })
      .catch((e) => {
        if (alive) setError(desktopError(e));
      });
    const onWheel = (event: WheelEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".pin-image-area")
      )
        return;
      event.preventDefault();
      if (!event.deltaY) return;
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1);
      actions.current.requestZoom(
        zoomTarget.current.scale *
          Math.exp(-Math.max(-120, Math.min(120, delta)) * 0.0012),
        event.clientX / innerWidth,
        event.clientY / innerHeight,
      );
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("input,textarea,select")
      )
        return;
      const ctrl = event.ctrlKey || event.metaKey;
      let action = "";
      if (ctrl && event.key.toLowerCase() === "c")
        action = event.shiftKey ? "copy-original" : "copy";
      if (ctrl && event.key.toLowerCase() === "s") action = "save";
      if (ctrl && event.key.toLowerCase() === "v") action = "paste";
      if (ctrl && event.key === "0") action = "zoom:1";
      if (event.key === "Escape") action = "escape";
      if (ctrl && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? actions.current.redoMark() : actions.current.undo();
        return;
      }
      if (action) {
        event.preventDefault();
        actions.current.dispatch(action);
      }
    };
    document.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    const scaleListener = getCurrentWindow().onScaleChanged(() => {
      actions.current.syncDpi();
    });
    return () => {
      alive = false;
      mounted.current = false;
      document.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      clearTimeout(noticeTimer.current);
      void scaleListener.then((unlisten) => unlisten()).catch(() => {});
      void menu.current?.close().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!info) return;
    let alive = true;
    setSource(null);
    void loadPinCanvas(info.dataUrl)
      .then((value) => {
        if (alive) setSource(value);
      })
      .catch((e) => {
        if (alive) setError(desktopError(e));
      });
    return () => {
      alive = false;
    };
  }, [info?.dataUrl]);
  useEffect(() => {
    if (!source || !canvas.current) return;
    const ctx = canvas.current.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, source.width, source.height);
    ctx.drawImage(source, 0, 0);
    marks.forEach((mark) => paintCaptureMark(ctx, mark, source));
    if (live) paintCaptureMark(ctx, live, source);
  }, [source, marks, live]);

  function message(value: string) {
    clearTimeout(noticeTimer.current);
    setNotice(value);
    noticeTimer.current = setTimeout(() => {
      if (mounted.current) setNotice("");
    }, 2000);
  }
  async function run(task: () => Promise<void>) {
    if (!mounted.current || locked.current || zooming.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      if (mounted.current) setError(desktopError(e));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function updateGeometry(geometry: PinGeometry, revision: number) {
    if (!mounted.current || current.current?.revision !== revision) return;
    const next = { ...current.current, ...geometry };
    current.current = next;
    if (!zooming.current) zoomTarget.current.scale = geometry.scale;
    setInfo(next);
  }
  function syncDpi() {
    void run(async () => {
      const value = current.current;
      if (!value) return;
      const geometry = await invoke<PinGeometry>("pinned_resize", {
        revision: value.revision,
        scale: value.scale,
        editing,
      });
      updateGeometry(geometry, value.revision);
    });
  }
  function requestZoom(scale: number, x = 0.5, y = 0.5) {
    if (
      locked.current ||
      editing ||
      !current.current ||
      !Number.isFinite(scale)
    )
      return;
    zoomTarget.current = {
      scale: scale === 0 ? 0 : Math.max(0.05, Math.min(4, scale)),
      x,
      y,
    };
    if (zooming.current) return;
    zooming.current = true;
    void (async () => {
      try {
        while (mounted.current && current.current) {
          const target = zoomTarget.current;
          const revision = current.current.revision;
          const geometry = await invoke<PinGeometry>("pinned_resize", {
            revision,
            scale: target.scale,
            editing: false,
            anchorX: target.x,
            anchorY: target.y,
          });
          updateGeometry(geometry, revision);
          if (zoomTarget.current === target) {
            zoomTarget.current.scale = geometry.scale;
            break;
          }
        }
      } catch (e) {
        if (mounted.current) {
          setError(desktopError(e));
          zoomTarget.current.scale = current.current?.scale || 1;
        }
      } finally {
        zooming.current = false;
      }
    })();
  }
  async function beginAnnotation() {
    const value = current.current;
    if (!value || !source) return;
    const geometry = await invoke<PinGeometry>("pinned_resize", {
      revision: value.revision,
      scale: value.scale,
      editing: true,
    });
    updateGeometry(geometry, value.revision);
    setMarks([]);
    setRedo([]);
    setText("");
    setEditing(true);
    await getCurrentWindow().setFocus();
  }
  async function applyAnnotation() {
    const value = current.current;
    if (!value || !source) throw new Error("图片尚未加载");
    if (drawing.current) throw new Error("请先完成当前笔画");
    if (!marks.length) {
      const geometry = await invoke<PinGeometry>("pinned_resize", {
        revision: value.revision,
        scale: value.scale,
        editing: false,
      });
      updateGeometry(geometry, value.revision);
      setEditing(false);
      return current.current!;
    }
    const output = document.createElement("canvas");
    output.width = source.width;
    output.height = source.height;
    const ctx = output.getContext("2d")!;
    ctx.drawImage(source, 0, 0);
    marks.forEach((mark) => paintCaptureMark(ctx, mark, source));
    const next = await invoke<PinInfo>("pinned_update", {
      revision: value.revision,
      dataUrl: output.toDataURL("image/png"),
    });
    if (mounted.current) accept(next);
    return next;
  }
  async function cancelAnnotation() {
    const value = current.current;
    if (!value) return;
    drawing.current = null;
    setLive(null);
    setMarks([]);
    setRedo([]);
    setEditing(false);
    const geometry = await invoke<PinGeometry>("pinned_resize", {
      revision: value.revision,
      scale: value.scale,
      editing: false,
    });
    updateGeometry(geometry, value.revision);
  }
  function undo() {
    if (!editing || busy || drawing.current || !marks.length) return;
    setMarks(marks.slice(0, -1));
    setRedo([...redo, marks[marks.length - 1]]);
  }
  function redoMark() {
    if (!editing || busy || drawing.current || !redo.length) return;
    setRedo(redo.slice(0, -1));
    setMarks([...marks, redo[redo.length - 1]]);
  }
  function dispatch(action: string) {
    if (!mounted.current) return;
    if (action === "close") {
      void getCurrentWindow()
        .hide()
        .catch((e) => setError(desktopError(e)));
      return;
    }
    if (action === "destroy") {
      void getCurrentWindow()
        .close()
        .catch((e) => setError(desktopError(e)));
      return;
    }
    if (action === "escape") {
      if (editing) void run(cancelAnnotation);
      else dispatch("close");
      return;
    }
    if (action === "shadow") {
      setShadow((value) => !value);
      return;
    }
    if (action.startsWith("zoom:")) {
      requestZoom(Number(action.slice(5)));
      return;
    }
    if (action.startsWith("opacity:")) {
      setOpacity(Number(action.slice(8)));
      return;
    }
    void run(async () => {
      let value = current.current;
      if (!value) throw new Error("图片尚未加载");
      if (action === "annotate") {
        if (editing) await applyAnnotation();
        else await beginAnnotation();
        return;
      }
      if (action === "copy-size") {
        await invoke("plugin:clipboard-manager|write_text", {
          text: `${value.width} × ${value.height}`,
        });
        message("已复制尺寸");
        return;
      }
      if (["copy", "copy-original", "save"].includes(action)) {
        if (editing) value = await applyAnnotation();
        const done = await invoke<boolean>("pinned_export", {
          revision: value.revision,
          action: action === "save" ? "save" : "copy",
          originalSize: action !== "copy",
        });
        if (done && mounted.current)
          message(action === "save" ? "已保存" : "已复制");
        return;
      }
      if (editing) throw new Error("请先完成或取消标注");
      if (action === "paste" || action === "replace") {
        const next = await invoke<PinInfo | null>("pinned_replace", {
          revision: value.revision,
          source: action === "paste" ? "clipboard" : "file",
        });
        if (next && mounted.current) accept(next);
        return;
      }
      if (!source) throw new Error("图片尚未加载");
      const dataUrl =
        action === "reset-image"
          ? value.originalUrl || value.dataUrl
          : processPinImage(source, action);
      const next = await invoke<PinInfo>("pinned_update", {
        revision: value.revision,
        dataUrl,
      });
      if (mounted.current) accept(next);
    });
  }
  async function openMenu(x?: number, y?: number, zoomOnly = false) {
    const value = current.current;
    if (!value || menuOpening.current) return;
    menuOpening.current = true;
    try {
      await menu.current?.close();
      const items = pinMenuItems(
        value,
        { editing, shadow, opacity, busy: busy || !source },
        (action) => actions.current.dispatch(action),
      );
      const zoom = items?.find(
        (item) => "text" in item && item.text === "缩放",
      );
      const next = await Menu.new({
        items:
          zoomOnly && zoom && "items" in zoom && Array.isArray(zoom.items)
            ? zoom.items
            : items,
      });
      if (!mounted.current) {
        await next.close();
        return;
      }
      menu.current = next;
      await next.popup(
        x === undefined || y === undefined
          ? undefined
          : new LogicalPosition(x, y),
      );
    } catch (e) {
      if (mounted.current) setError(desktopError(e));
    } finally {
      menuOpening.current = false;
    }
  }
  function point(event: PointerEvent): CapturePoint {
    const box = canvas.current!.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          info!.width,
          ((event.clientX - box.left) * info!.width) / box.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          info!.height,
          ((event.clientY - box.top) * info!.height) / box.height,
        ),
      ),
    };
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || busy || !source || !info) return;
    if (!editing) {
      void getCurrentWindow()
        .startDragging()
        .catch((e) => setError(desktopError(e)));
      return;
    }
    event.preventDefault();
    const at = point(event);
    const mark: CaptureMark = {
      tool,
      points: [at],
      color,
      width,
      size: fontSize,
    };
    if (tool === "text") {
      if (!text.trim()) {
        setError("先在下方输入文字，再点击图片放置");
        return;
      }
      const ctx = source.getContext("2d")!;
      ctx.font = `${fontSize}px "Microsoft YaHei", sans-serif`;
      const lines: string[] = [];
      for (const raw of text.split("\n")) {
        let line = "";
        for (const char of raw) {
          if (ctx.measureText(char).width > info.width - at.x) {
            setError("这个位置放不下文字，请向左移动或减小字号");
            return;
          }
          if (line && ctx.measureText(line + char).width > info.width - at.x) {
            lines.push(line);
            line = char;
          } else line += char;
        }
        lines.push(line);
      }
      if (at.y + lines.length * fontSize * 1.4 > info.height) {
        setError("这个位置放不下文字，请向上移动或减小字号");
        return;
      }
      mark.text = lines.join("\n");
      setMarks((values) => [...values, mark]);
      setRedo([]);
      setError("");
      return;
    }
    drawing.current = { pointer: event.pointerId, mark };
    event.currentTarget.setPointerCapture(event.pointerId);
    setLive(mark);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const gesture = drawing.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const at = point(event);
    gesture.mark = {
      ...gesture.mark,
      points:
        gesture.mark.tool === "pen"
          ? [...gesture.mark.points.slice(-9999), at]
          : [gesture.mark.points[0], at],
    };
    setLive(gesture.mark);
  }
  function end(event: PointerEvent<HTMLDivElement>, cancel = false) {
    const gesture = drawing.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    drawing.current = null;
    setLive(null);
    if (!cancel) {
      const mark =
        gesture.mark.points.length === 1
          ? {
              ...gesture.mark,
              points: [
                ...gesture.mark.points,
                {
                  x: gesture.mark.points[0].x + 0.1,
                  y: gesture.mark.points[0].y + 0.1,
                },
              ],
            }
          : gesture.mark;
      setMarks((values) => [...values, mark]);
      setRedo([]);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return (
    <main
      ref={root}
      className={`pin-window ${editing ? "is-editing" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        void openMenu(event.clientX, event.clientY);
      }}
      aria-label="钉住的截图"
      aria-busy={busy}
    >
      {info && source && (
        <div
          className={`pin-image-area ${shadow ? "has-shadow" : ""} ${editing ? "is-editing" : ""}`}
          style={{
            width: (info.width * info.scale) / info.dpi,
            height: (info.height * info.scale) / info.dpi,
            opacity,
          }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={(event) => end(event)}
          onPointerCancel={(event) => end(event, true)}
        >
          <canvas
            ref={canvas}
            width={info.width}
            height={info.height}
            role="img"
            aria-label={`贴图，${info.width} × ${info.height} 像素`}
          />
        </div>
      )}
      <div className="pin-toolbar" role="toolbar" aria-label="贴图窗口操作">
        <Hint label="缩放比例" side="bottom">
          <button
            className="pin-zoom"
            type="button"
            disabled={!info || busy || editing}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              void openMenu(box.left, box.bottom + 4, true);
            }}
          >
            {info ? `${Math.round(info.scale * 100)}%` : "…"}
          </button>
        </Hint>
        <Hint label="关闭贴图" side="bottom">
          <button
            type="button"
            aria-label="关闭贴图"
            onClick={() => dispatch("close")}
          >
            <X size={15} />
          </button>
        </Hint>
      </div>
      {editing && (
        <div className="pin-editor" aria-label="贴图标注">
          <div
            className="pin-editor-tools"
            role="toolbar"
            aria-label="标注工具"
          >
            {tools.map(([value, label, Icon]) => (
              <Hint key={value} label={label}>
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={tool === value}
                  disabled={busy}
                  onClick={() => setTool(value)}
                >
                  <Icon size={16} />
                </button>
              </Hint>
            ))}
            <Hint label="撤销">
              <button
                type="button"
                aria-label="撤销"
                disabled={!marks.length || busy}
                onClick={undo}
              >
                <Undo2 size={16} />
              </button>
            </Hint>
            <Hint label="重做">
              <button
                type="button"
                aria-label="重做"
                disabled={!redo.length || busy}
                onClick={redoMark}
              >
                <Redo2 size={16} />
              </button>
            </Hint>
            <Hint label="完成标注">
              <button
                type="button"
                className="pin-apply"
                aria-label="完成标注"
                disabled={busy}
                onClick={() => dispatch("annotate")}
              >
                <Check size={16} />
              </button>
            </Hint>
            <Hint label="取消本次标注">
              <button
                type="button"
                aria-label="取消本次标注"
                disabled={busy}
                onClick={() => void run(cancelAnnotation)}
              >
                <X size={16} />
              </button>
            </Hint>
          </div>
          <div className="pin-editor-style">
            <label>
              颜色
              <input
                type="color"
                value={color}
                disabled={busy}
                onChange={(event) => setColor(event.target.value)}
              />
            </label>
            <label>
              粗细
              <select
                value={width}
                disabled={busy}
                onChange={(event) => setWidth(Number(event.target.value))}
              >
                {[1, 3, 5, 8].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              字号
              <select
                value={fontSize}
                disabled={busy}
                onChange={(event) => setFontSize(Number(event.target.value))}
              >
                {[12, 16, 20, 24, 32, 48, 72].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            {tool === "text" && (
              <input
                className="pin-text"
                aria-label="标注文字"
                placeholder="输入文字，点击图片放置"
                maxLength={2000}
                value={text}
                disabled={busy}
                onChange={(event) => setText(event.target.value)}
              />
            )}
          </div>
        </div>
      )}
      {(error || notice) && (
        <div
          className={`pin-feedback ${error ? "is-error" : ""}`}
          role={error ? "alert" : "status"}
        >
          <span>{error || notice}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}
    </main>
  );
}
