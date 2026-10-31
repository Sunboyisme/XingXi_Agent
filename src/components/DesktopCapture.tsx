import { paintCaptureMark as paint } from "@/lib/captureDrawing";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { containCaptureText } from "@/lib/captureTextLayout";
import { Popover } from "radix-ui";
import {
  Pencil,
  Square,
  Circle,
  Type,
  Grid2X2,
  Undo2,
  Redo2,
  Pin,
  ScanText,
  Languages,
  Download,
  ImagePlus,
  X,
  Check,
  Move,
  GripVertical,
  Crop,
  Eraser,
  ChevronDown,
  CaseSensitive,
} from "lucide-react";
import { Hint } from "./common";
import { invoke, desktopListen, desktopError } from "@/lib/desktopAssistant";

type Point = { x: number; y: number };
type Rect = Point & { w: number; h: number };
type Tool =
  | "move"
  | "pen"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text"
  | "mosaic"
  | "erase";
type Mark = {
  tool: Tool;
  points: Point[];
  color: string;
  width: number;
  size: number;
  text?: string;
};
type Session = {
  id: string;
  width: number;
  height: number;
  x: number;
  y: number;
  cursorX: number;
  cursorY: number;
  monitorX: number;
  monitorY: number;
  monitorWidth: number;
  monitorHeight: number;
  windows: Rect[];
};
type Gesture = {
  pointerId: number;
  start: Point;
  original?: Rect;
  handle?: string;
  mark?: Mark;
  erase?: boolean;
  automatic?: Rect;
};
type TextGesture = {
  pointerId: number;
  sessionId: string;
  index: number;
  before: Mark[];
  original: Mark;
  preview: Mark;
  bounds: Rect;
  start: Point;
  handle?: string;
  moved: boolean;
};
const rect = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});
const inside = (r: Rect, p: Point) =>
  p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h;
const captureHandles = {
  nw: "左上", n: "上", ne: "右上", e: "右", se: "右下", s: "下", sw: "左下", w: "左",
};
function resizeSelection(r: Rect, handle: string, dx: number, dy: number, bounds: { width: number; height: number }): Rect {
  let left = r.x, top = r.y, right = r.x + r.w, bottom = r.y + r.h;
  if (handle.includes("w")) left = Math.max(0, Math.min(right - 2, left + dx));
  if (handle.includes("e")) right = Math.min(bounds.width, Math.max(left + 2, right + dx));
  if (handle.includes("n")) top = Math.max(0, Math.min(bottom - 2, top + dy));
  if (handle.includes("s")) bottom = Math.min(bounds.height, Math.max(top + 2, bottom + dy));
  return { x: left, y: top, w: right - left, h: bottom - top };
}
function wrapAnnotation(
  ctx: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
) {
  return value.split("\n").flatMap((raw) => {
    const lines: string[] = [];
    let line = "";
    for (const char of raw) {
      if (line && ctx.measureText(line + char).width > maxWidth) {
        lines.push(line);
        line = char;
      } else line += char;
    }
    lines.push(line);
    return lines;
  });
}
const colors = [
  "#ef4444",
  "#facc15",
  "#22c55e",
  "#3b82f6",
  "#ffffff",
  "#111827",
];
function LineToolIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 16 16 4" />
      <circle cx="4" cy="16" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="16" cy="4" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
function ArrowToolIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 16 16 4M7 4h9v9" />
    </svg>
  );
}
function CaptureStylePicker({
  label,
  preview,
  children,
}: {
  label: string;
  preview: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover.Root>
      <Hint label={label}>
        <Popover.Trigger className="capture-style-trigger" aria-label={label}>
          {preview}
          <ChevronDown size={11} />
        </Popover.Trigger>
      </Hint>
      <Popover.Portal>
        <Popover.Content
          className="capture-style-menu"
          side="top"
          sideOffset={8}
          collisionPadding={8}
          aria-label={label}
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
const tools = [
  ["move", "移动选区", Move],
  ["pen", "画笔", Pencil],
  ["line", "直线", LineToolIcon],
  ["arrow", "箭头", ArrowToolIcon],
  ["rect", "矩形", Square],
  ["ellipse", "椭圆", Circle],
  ["text", "文字", Type],
  ["mosaic", "马赛克", Grid2X2],
  ["erase", "框选删除标注：拖拽框选，松开删除，可撤销", Eraser],
] as const;

function markBounds(mark: Mark, ctx: CanvasRenderingContext2D): Rect {
  if (mark.tool === "text") {
    ctx.font = `${mark.size}px "Microsoft YaHei", sans-serif`;
    const lines = (mark.text || "").split("\n");
    return {
      ...mark.points[0],
      w: Math.max(1, ...lines.map((line) => ctx.measureText(line).width)),
      h: lines.length * mark.size * 1.4,
    };
  }
  const padding = Math.max(mark.width / 2, mark.tool === "arrow" ? 12 : 2);
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const p of mark.points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return {
    x: left - padding,
    y: top - padding,
    w: right - left + padding * 2,
    h: bottom - top + padding * 2,
  };
}

export function DesktopCapture() {
  const [session, setSession] = useState<Session>();
  const [selection, setSelection] = useState<Rect | null>(null);
  const [automatic, setAutomatic] = useState<Rect | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [redo, setRedo] = useState<Mark[][]>([]);
  const [history, setHistory] = useState<Mark[][]>([]);
  const [live, setLive] = useState<Mark | null>(null);
  const [eraseBox, setEraseBox] = useState<Rect | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [color, setColor] = useState(colors[0]);
  const [width, setWidth] = useState(3);
  const [fontSize, setFontSize] = useState(24);
  const [text, setText] = useState<{
    at: Point;
    value: string;
    index?: number;
  } | null>(null);
  const root = useRef<HTMLElement>(null);
  const textGesture = useRef<TextGesture | null>(null);
  const currentSession = useRef<Session | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toolbar, setToolbar] = useState<Point | null>(null);
  const [viewport, setViewport] = useState({ w: innerWidth, h: innerHeight });
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef<HTMLCanvasElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const gestureTarget = useRef<Element | null>(null);
  const toolbarDrag = useRef<{
    pointerId: number;
    start: Point;
    original: Point;
  } | null>(null);
  const toolbarElement = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState({ w: 760, h: 44 });
  const textInput = useRef<HTMLTextAreaElement>(null);
  const textOverflow = useRef(false);
  const [textOverflowMessage, setTextOverflowMessage] = useState("");
  const epoch = useRef(0);
  const exportLock = useRef(false);
  const commands = useRef({
    undo,
    redoAction,
    finish,
    commitText,
    cancelCapture,
  });
  commands.current = {
    undo,
    redoAction,
    finish,
    commitText,
    cancelCapture,
  };
  const sx = session ? viewport.w / session.width : 1,
    sy = session ? viewport.h / session.height : 1;
  const styleRect = (r: Rect) => ({
    left: r.x * sx,
    top: r.y * sy,
    width: r.w * sx,
    height: r.h * sy,
  });

  useEffect(() => {
    let alive = true;
    async function load() {
      releaseTextGesture();
      const current = ++epoch.current;
      let active = false;
      setSelection(null);
      setAutomatic(null);
      setMarks([]);
      setHistory([]);
      setRedo([]);
      setLive(null);
      setEraseBox(null);
      setText(null);
      setTool("move");
      setError("");
      setBusy(false);
      exportLock.current = false;
      setToolbar(null);
      gesture.current = null;
      let loadingId = "";
      try {
        const s = await invoke<Session>("capture_get");
        if (!alive || current !== epoch.current) return;
        loadingId = s.id;
        currentSession.current = s;
        active = true;
        const raw = await invoke<ArrayBuffer | number[]>("capture_pixels", {
          id: s.id,
        });
        if (!alive || current !== epoch.current) return;
        const pixels = new Uint8ClampedArray(
          raw instanceof ArrayBuffer ? raw : new Uint8Array(raw).buffer,
        );
        if (pixels.length !== s.width * s.height * 4)
          throw new Error("截图像素不完整，请重新截图");
        const bitmap = document.createElement("canvas");
        bitmap.width = s.width;
        bitmap.height = s.height;
        bitmap
          .getContext("2d")!
          .putImageData(new ImageData(pixels, s.width, s.height), 0, 0);
        source.current = bitmap;
        setAutomatic(
          s.windows.find((window) =>
            inside(window, { x: s.cursorX, y: s.cursorY }),
          ) || null,
        );
        setSession(s);
        if (alive && current === epoch.current)
          await invoke("capture_present", { id: s.id });
      } catch (e) {
        if (alive && current === epoch.current && active) {
          setError(desktopError(e));
          await invoke("capture_failed", {
            id: loadingId,
            message: desktopError(e),
          });
        }
      }
    }
    const unlisten = desktopListen("capture-ready", () => void load());
    const dismissListener = desktopListen<string>("capture-dismiss", (id) => {
      if (currentSession.current?.id !== id) return;
      releaseTextGesture();
      const activeGesture = gesture.current;
      if (
        activeGesture &&
        gestureTarget.current?.hasPointerCapture(activeGesture.pointerId)
      )
        gestureTarget.current.releasePointerCapture(activeGesture.pointerId);
      gestureTarget.current = null;
      const toolbarGesture = toolbarDrag.current;
      const grip = toolbarElement.current?.querySelector(".toolbar-grip");
      if (toolbarGesture && grip?.hasPointerCapture(toolbarGesture.pointerId))
        grip.releasePointerCapture(toolbarGesture.pointerId);
      toolbarDrag.current = null;
      epoch.current++;
      currentSession.current = null;
      gesture.current = null;
      source.current = null;
      setSession(undefined);
      setSelection(null);
      setAutomatic(null);
      setMarks([]);
      setHistory([]);
      setRedo([]);
      setLive(null);
      setEraseBox(null);
      setText(null);
      setBusy(false);
      setDragging(false);
      exportLock.current = false;
    });
    void Promise.all([unlisten, dismissListener]).then(() => {
      if (alive) void load();
    });
    const resize = () => setViewport({ w: innerWidth, h: innerHeight });
    window.addEventListener("resize", resize);
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest(".capture-style-menu")) return;
      if (textGesture.current) {
        if (e.key === "Escape") {
          e.preventDefault();
          endText({ pointerId: textGesture.current.pointerId }, true);
        }
        return;
      }
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        void commands.current.cancelCapture();
        return;
      }
      if (
        (e.target as HTMLElement)?.matches("textarea,input,select") ||
        e.isComposing
      )
        return;
      if (e.ctrlKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) commands.current.redoAction();
        else commands.current.undo();
      } else if (e.ctrlKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        commands.current.redoAction();
      } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void commands.current.finish("copy");
      } else if (
        e.key === "Enter" &&
        !(e.target as HTMLElement)?.closest("button,[role=button]")
      ) {
        e.preventDefault();
        void commands.current.finish("copy");
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      alive = false;
      epoch.current++;
      void unlisten.then((f) => f());
      void dismissListener.then((f) => f());
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", key);
    };
  }, []);
  async function cancelCapture() {
    const id = currentSession.current?.id;
    if (id)
      await invoke("capture_cancel", { id }).catch((e) => {
        if (currentSession.current?.id === id) setError(desktopError(e));
      });
  }
  function resetSelection() {
    releaseTextGesture();
    const g = gesture.current;
    if (g && gestureTarget.current?.hasPointerCapture(g.pointerId))
      gestureTarget.current.releasePointerCapture(g.pointerId);
    gestureTarget.current = null;
    gesture.current = null;
    setSelection(null);
    setAutomatic(null);
    setMarks([]);
    setHistory([]);
    setRedo([]);
    setToolbar(null);
    setLive(null);
    setEraseBox(null);
    setText(null);
    setTool("move");
    setDragging(false);
  }
  useEffect(() => {
    if (text) textInput.current?.focus();
  }, [Boolean(text), text?.index]);
  useLayoutEffect(() => {
    const node = textInput.current,
      context = source.current?.getContext("2d");
    if (!text || !node || !context || !session || !selection) {
      textOverflow.current = false;
      setTextOverflowMessage("");
      return;
    }
    context.save();
    context.font = `${fontSize}px "Microsoft YaHei", sans-serif`;
    const natural = text.value
      .split("\n")
      .reduce(
        (width, line) => Math.max(width, context.measureText(line).width),
        fontSize * 2,
      );
    const available = Math.min(
      session.width,
      Math.max(
        fontSize * 2 + 2,
        Math.min(
          (viewport.w - text.at.x * sx - 8) / sx,
          selection.x + selection.w - text.at.x,
        ),
      ),
    );
    node.style.width = `${Math.min(natural + 2, available) * sx}px`;
    node.style.lineHeight = `${fontSize * sy * 1.4}px`;
    node.style.overflowY = "hidden";
    node.style.height = "0px";
    const height = Math.max(fontSize * sy * 1.4, node.scrollHeight);
    node.style.height = `${Math.min(height, viewport.h)}px`;
    node.style.overflowY = height > viewport.h ? "auto" : "hidden";
    const fit = containCaptureText(
      selection,
      text.at,
      {
        w: node.getBoundingClientRect().width / sx,
        h: height / sy,
      },
      { w: session.width, h: session.height },
    );
    textOverflow.current = fit.overflow;
    setTextOverflowMessage(
      fit.overflow
        ? "文字超过当前屏幕可容纳的范围，请减少内容或调整字号后完成截图。"
        : "",
    );
    if (
      Math.abs(fit.at.x - text.at.x) > 0.01 ||
      Math.abs(fit.at.y - text.at.y) > 0.01
    )
      setText((old) => (old === text ? { ...old, at: fit.at } : old));
    if (
      ["x", "y", "w", "h"].some(
        (key) =>
          Math.abs(fit.crop[key as keyof Rect] - selection[key as keyof Rect]) >
          0.01,
      )
    )
      setSelection((old) => (old === selection ? fit.crop : old));
    context.restore();
  }, [text, fontSize, sx, sy, viewport.w, viewport.h, selection, session]);
  useEffect(() => {
    const node = toolbarElement.current;
    if (!node) return;
    const resize = new ResizeObserver(() =>
      setToolbarSize({ w: node.offsetWidth, h: node.offsetHeight }),
    );
    resize.observe(node);
    return () => resize.disconnect();
  }, [Boolean(selection && selection.w >= 2 && !dragging)]);
  useEffect(() => {
    if (!session || !source.current || !canvas.current) return;
    const ctx = canvas.current.getContext("2d")!;
    ctx.clearRect(0, 0, session.width, session.height);
    ctx.drawImage(source.current, 0, 0);
    const region = selection || automatic;
    ctx.fillStyle = selection ? "rgba(0,0,0,.48)" : "rgba(0,0,0,.22)";
    ctx.fillRect(0, 0, session.width, session.height);
    if (region) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(region.x, region.y, region.w, region.h);
      ctx.clip();
      ctx.drawImage(source.current, 0, 0);
      marks.forEach((m, index) => {
        if (index !== text?.index) paint(ctx, m, source.current!);
      });
      if (live) paint(ctx, live, source.current);
      ctx.restore();
    }
  }, [session, selection, automatic, marks, live, text?.index]);
  function addMark(mark: Mark) {
    setHistory((h) => [...h, marks]);
    setMarks((m) => [...m, mark]);
    setRedo([]);
  }
  function undo() {
    if (text) {
      setText(null);
      return;
    }
    if (!history.length || exportLock.current) return;
    setRedo((r) => [...r, marks]);
    setMarks(history.at(-1)!);
    setHistory((h) => h.slice(0, -1));
  }
  function redoAction() {
    if (text) {
      setText(null);
      return;
    }
    if (!redo.length || exportLock.current) return;
    setHistory((h) => [...h, marks]);
    setMarks(redo.at(-1)!);
    setRedo((r) => r.slice(0, -1));
  }
  function commitText() {
    if (!text || textOverflow.current) return;
    const next = editedMarks();
    if (JSON.stringify(next) !== JSON.stringify(marks)) {
      setHistory((h) => [...h, marks]);
      setMarks(next);
      setRedo([]);
    }
    setText(null);
  }
  function editedMarks() {
    if (!text) return marks;
    const mark: Mark | null = text.value.trim()
      ? {
          tool: "text",
          points: [text.at],
          color,
          width,
          size: fontSize,
          text: annotationValue(),
        }
      : null;
    if (text.index !== undefined)
      return marks.flatMap((item, index) =>
        index === text.index ? (mark ? [mark] : []) : [item],
      );
    return mark ? [...marks, mark] : marks;
  }
  function annotationValue() {
    if (!text) return "";
    const context = source.current?.getContext("2d");
    if (!context || !textInput.current) return text.value;
    context.save();
    context.font = `${fontSize}px "Microsoft YaHei", sans-serif`;
    const result = wrapAnnotation(
      context,
      text.value,
      textInput.current.clientWidth / sx,
    ).join("\n");
    context.restore();
    return result;
  }
  function point(e: ReactPointerEvent): Point {
    return {
      x: Math.max(0, Math.min(session?.width || 1, e.clientX / sx)),
      y: Math.max(0, Math.min(session?.height || 1, e.clientY / sy)),
    };
  }
  function beginText(e: ReactPointerEvent, index?: number, handle?: string) {
    if (e.button !== 0 || busy || !session || !root.current) return;
    if (index === undefined && !text?.value.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    const context = source.current?.getContext("2d");
    if (!context) return;
    const before = editedMarks();
    const target =
      index === undefined
        ? (text?.index ?? before.length - 1)
        : before.indexOf(marks[index]);
    const mark = before[target];
    if (!mark || mark.tool !== "text") return;
    if (text) commitText();
    textGesture.current = {
      pointerId: e.pointerId,
      sessionId: session.id,
      index: target,
      before,
      original: mark,
      preview: mark,
      bounds: markBounds(mark, context),
      start: point(e),
      handle,
      moved: false,
    };
    root.current.setPointerCapture(e.pointerId);
    root.current.style.cursor = handle
      ? ["nw", "se"].includes(handle)
        ? "nwse-resize"
        : "nesw-resize"
      : "move";
  }
  function moveText(e: ReactPointerEvent) {
    const g = textGesture.current;
    if (
      !g ||
      g.pointerId !== e.pointerId ||
      g.sessionId !== currentSession.current?.id ||
      !session
    )
      return;
    const p = point(e),
      dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < 3 / sx) return;
    g.moved = true;
    let at = { x: g.original.points[0].x + dx, y: g.original.points[0].y + dy },
      size = g.original.size;
    let width = g.bounds.w,
      height = g.bounds.h;
    if (g.handle) {
      const ax = g.handle.includes("w") ? g.bounds.x + g.bounds.w : g.bounds.x;
      const ay = g.handle.includes("n") ? g.bounds.y + g.bounds.h : g.bounds.y;
      const distance = Math.max(1, Math.hypot(g.start.x - ax, g.start.y - ay));
      size = Math.max(
        6,
        Math.min(
          200,
          Math.round(
            (g.original.size * Math.hypot(p.x - ax, p.y - ay)) / distance,
          ),
        ),
      );
      const scale = size / g.original.size;
      width *= scale;
      height *= scale;
      at = {
        x: g.handle.includes("w") ? ax - width : ax,
        y: g.handle.includes("n") ? ay - height : ay,
      };
    }
    const area = selection || {
      x: 0,
      y: 0,
      w: session.width,
      h: session.height,
    };
    at.x = Math.max(area.x, Math.min(area.x + area.w - width, at.x));
    at.y = Math.max(area.y, Math.min(area.y + area.h - height, at.y));
    g.preview = { ...g.original, points: [at], size };
    setText(null);
    setDragging(true);
    setMarks(g.before.map((mark, i) => (i === g.index ? g.preview : mark)));
  }
  function endText(e: { pointerId: number }, cancel = false) {
    const g = textGesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    textGesture.current = null;
    if (root.current) root.current.style.cursor = "";
    if (root.current?.hasPointerCapture(e.pointerId))
      root.current.releasePointerCapture(e.pointerId);
    if (g.sessionId !== currentSession.current?.id) return;
    if (cancel) setMarks(g.before);
    else if (g.moved) {
      setHistory((h) => [...h, g.before]);
      setRedo([]);
    }
    const mark = cancel ? g.original : g.preview;
    setText({ at: mark.points[0], value: mark.text || "", index: g.index });
    setFontSize(mark.size);
    setColor(mark.color);
    setDragging(false);
  }
  function releaseTextGesture() {
    const g = textGesture.current;
    textGesture.current = null;
    if (root.current) root.current.style.cursor = "";
    if (g && root.current?.hasPointerCapture(g.pointerId))
      root.current.releasePointerCapture(g.pointerId);
  }
  function editText(index: number) {
    const original = marks[index],
      next = editedMarks(),
      target = next.indexOf(original);
    if (!original || target < 0) return;
    if (text) commitText();
    setText({
      at: original.points[0],
      value: original.text || "",
      index: target,
    });
    setFontSize(original.size);
    setColor(original.color);
  }
  function begin(e: ReactPointerEvent, handle?: string) {
    if (!session || busy || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = point(e);
    const selected = selection || (handle ? automatic : null);
    if (!selection && selected) setSelection(selected);
    if (!selection) setError("");
    if (text) {
      commitText();
      return;
    }
    if (selected && tool === "erase" && !handle && inside(selected, p)) {
      gesture.current = { pointerId: e.pointerId, start: p, erase: true };
      setEraseBox({ ...p, w: 0, h: 0 });
      e.currentTarget.setPointerCapture(e.pointerId);
      gestureTarget.current = e.currentTarget;
      setDragging(true);
      return;
    }
    if (selected && tool === "text" && !handle && inside(selected, p)) {
      setText({ at: p, value: "" });
      return;
    }
    const original =
      selected &&
      (handle || tool === "move") &&
      inside(
        {
          x: selected.x - 15 / sx,
          y: selected.y - 15 / sy,
          w: selected.w + 30 / sx,
          h: selected.h + 30 / sy,
        },
        p,
      )
        ? { ...selected }
        : undefined;
    const mark =
      selected && !original && inside(selected, p)
        ? { tool, points: [p], color, width, size: fontSize }
        : undefined;
    gesture.current = {
      pointerId: e.pointerId,
      start: p,
      original,
      handle,
      mark,
      automatic: !selection
        ? session.windows.find((window) => inside(window, p))
        : undefined,
    };
    if (!original && !mark) {
      setAutomatic(null);
      setSelection({ ...p, w: 0, h: 0 });
      setMarks([]);
      setHistory([]);
      setRedo([]);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureTarget.current = e.currentTarget;
    setDragging(true);
  }
  function move(e: ReactPointerEvent) {
    if (textGesture.current) {
      moveText(e);
      return;
    }
    const g = gesture.current;
    if (!session) return;
    if (!g) {
      if (!selection)
        setAutomatic(
          session.windows.find((window) => inside(window, point(e))) || null,
        );
      return;
    }
    if (g.pointerId !== e.pointerId) return;
    const p = point(e),
      dx = p.x - g.start.x,
      dy = p.y - g.start.y;
    if (g.erase) setEraseBox(rect(g.start, p));
    else if (g.original) {
      const r = g.original;
      if (!g.handle)
        setSelection({
          ...r,
          x: Math.max(0, Math.min(session.width - r.w, r.x + dx)),
          y: Math.max(0, Math.min(session.height - r.h, r.y + dy)),
        });
      else setSelection(resizeSelection(r, g.handle, dx, dy, session));
    } else if (g.mark) {
      g.mark.points =
        g.mark.tool === "pen" ? [...g.mark.points, p] : [g.start, p];
      setLive({ ...g.mark });
    } else setSelection(rect(g.start, p));
  }
  function end(e: ReactPointerEvent) {
    if (textGesture.current) {
      endText(e);
      return;
    }
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (g.erase) {
      const box = rect(g.start, point(e));
      const context = source.current?.getContext("2d");
      if (context) {
        const remaining = marks.filter((mark) => {
          const bounds = markBounds(mark, context);
          return (
            bounds.x > box.x + box.w ||
            bounds.x + bounds.w < box.x ||
            bounds.y > box.y + box.h ||
            bounds.y + bounds.h < box.y
          );
        });
        if (remaining.length !== marks.length) {
          setHistory((h) => [...h, marks]);
          setMarks(remaining);
          setRedo([]);
        }
      }
      setEraseBox(null);
    } else if (g.mark) addMark(g.mark);
    if (!g.erase && !g.mark && !g.original) {
      const box = rect(g.start, point(e));
      if (g.automatic && Math.hypot(box.w * sx, box.h * sy) < 5) {
        setSelection(g.automatic);
      } else if (box.w < 2 || box.h < 2) {
        setSelection(null);
      } else {
        setSelection(box);
      }
    }
    gesture.current = null;
    setLive(null);
    setDragging(false);
    if (gestureTarget.current?.hasPointerCapture(e.pointerId))
      gestureTarget.current.releasePointerCapture(e.pointerId);
    gestureTarget.current = null;
  }
  function cancelGesture(e: ReactPointerEvent) {
    if (textGesture.current) {
      endText(e, true);
      return;
    }
    if (gesture.current?.pointerId !== e.pointerId) return;
    const cancelled = gesture.current;
    if (!cancelled.erase && !cancelled.mark) {
      setSelection(cancelled.original || null);
      setAutomatic(cancelled.original ? null : cancelled.automatic || null);
    }
    gesture.current = null;
    setLive(null);
    setEraseBox(null);
    setDragging(false);
    if (gestureTarget.current?.hasPointerCapture(e.pointerId))
      gestureTarget.current.releasePointerCapture(e.pointerId);
    gestureTarget.current = null;
  }
  async function finish(action: string) {
    if (
      !selection ||
      selection.w < 2 ||
      selection.h < 2 ||
      !session ||
      !source.current ||
      exportLock.current ||
      textOverflow.current
    )
      return;
    const outputMarks = editedMarks();
    if (text) commitText();
    const id = session.id;
    exportLock.current = true;
    setBusy(true);
    setError("");
    try {
      const output = document.createElement("canvas");
      output.width = Math.round(selection.w);
      output.height = Math.round(selection.h);
      const ctx = output.getContext("2d")!;
      ctx.translate(-selection.x, -selection.y);
      ctx.drawImage(source.current, 0, 0);
      outputMarks.forEach((m) => paint(ctx, m, source.current!));
      const dataUrl = await new Promise<string>((resolve, reject) => {
        output.toBlob((blob) => {
          if (!blob) {
            reject(new Error("截图编码失败，请重试"));
            return;
          }
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("截图读取失败，请重试"));
          reader.readAsDataURL(blob);
        }, "image/png");
      });
      if (currentSession.current?.id !== id) return;
      await invoke("capture_export", {
        id,
        dataUrl,
        action,
        x: session.x + Math.round(selection.x),
        y: session.y + Math.round(selection.y),
      });
    } catch (e) {
      if (currentSession.current?.id === id) setError(desktopError(e));
    } finally {
      if (currentSession.current?.id === id) {
        exportLock.current = false;
        setBusy(false);
      }
    }
  }
  const box = selection ? styleRect(selection) : null;
  const frame = selection || automatic;
  const barPosition = box
    ? toolbar || {
        x: Math.max(
          8,
          Math.min(
            viewport.w - toolbarSize.w - 8,
            box.left + box.width - toolbarSize.w,
          ),
        ),
        y:
          box.top + box.height + toolbarSize.h + 16 < viewport.h
            ? box.top + box.height + 12
            : Math.max(8, box.top - toolbarSize.h - 12),
      }
    : { x: 0, y: 0 };
  return (
    <main
      ref={root}
      className="capture-window"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={cancelGesture}
    >
      <canvas
        ref={canvas}
        className="capture-canvas"
        width={session?.width || 1}
        height={session?.height || 1}
        onPointerDown={begin}
      />
      {frame && (
        <div
          className={selection ? "capture-selection" : "capture-auto-selection"}
          style={styleRect(frame)}
          data-moving={tool === "move"}
          onPointerDown={selection ? (e) => begin(e) : undefined}
        >
          {selection && <span className="capture-dimensions">
            {Math.round(selection.w)} × {Math.round(selection.h)}
          </span>}
          {Object.entries(captureHandles).map(([h, label]) => (
            <button
              key={h}
              className={`capture-handle handle-${h}`}
              aria-label={`调整截图${label}边缘`}
              onPointerDown={(e) => begin(e, h)}
              onClick={() => { if (!selection) setSelection(frame); }}
              onKeyDown={(e) => {
                const delta = e.shiftKey ? 10 : 1;
                const dx =
                  e.key === "ArrowLeft"
                    ? -delta
                    : e.key === "ArrowRight"
                      ? delta
                      : 0;
                const dy =
                  e.key === "ArrowUp"
                    ? -delta
                    : e.key === "ArrowDown"
                      ? delta
                      : 0;
                if (dx || dy) {
                  e.preventDefault();
                  setSelection((r) =>
                    session
                      ? resizeSelection(r || frame, h, dx, dy, session)
                      : r,
                  );
                }
              }}
            />
          ))}
        </div>
      )}
      {selection &&
        !dragging &&
        source.current &&
        marks.map((mark, index) => {
          if (
            mark.tool !== "text" ||
            text?.index === index ||
            !["move", "text"].includes(tool)
          )
            return null;
          const bounds = markBounds(mark, source.current!.getContext("2d")!);
          return (
            <div
              key={index}
              className="capture-text-object"
              style={styleRect(bounds)}
              onPointerDown={(e) => beginText(e, index)}
              role="button"
              tabIndex={0}
              aria-label="编辑文字标注"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  editText(index);
                }
              }}
            >
              {(["nw", "ne", "se", "sw"] as const).map((corner) => (
                <span
                  key={corner}
                  className={`capture-text-corner corner-${corner}`}
                  onPointerDown={(e) => beginText(e, index, corner)}
                />
              ))}
            </div>
          );
        })}
      {text && !dragging && (
        <div
          className="capture-text-editor"
          style={{ left: text.at.x * sx - 8, top: text.at.y * sy - 8 }}
        >
          <span
            className="capture-text-move-area"
            onPointerDown={(e) => beginText(e)}
            aria-hidden="true"
          />
          <textarea
            ref={textInput}
            className="capture-text"
            aria-label="截图文字"
            style={{
              color,
              fontSize: fontSize * sx,
            }}
            value={text.value}
            wrap="soft"
            onChange={(e) =>
              setText((t) => t && { ...t, value: e.target.value })
            }
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setText(null);
              } else if (
                e.ctrlKey &&
                e.key === "Enter" &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                commitText();
              }
            }}
          />
          {(["nw", "ne", "se", "sw"] as const).map((corner) => (
            <span
              key={corner}
              className={`capture-text-corner corner-${corner}`}
              aria-hidden="true"
              onPointerDown={(e) => beginText(e, undefined, corner)}
            />
          ))}
        </div>
      )}
      {eraseBox && (
        <div className="capture-erase-box" style={styleRect(eraseBox)} />
      )}
      {selection && selection.w >= 2 && !dragging && (
        <div
          ref={toolbarElement}
          className="capture-toolbar"
          style={{
            left: Math.max(
              8,
              Math.min(viewport.w - toolbarSize.w - 8, barPosition.x),
            ),
            top: Math.max(
              8,
              Math.min(viewport.h - toolbarSize.h - 8, barPosition.y),
            ),
          }}
        >
          <button
            aria-label="拖动工具栏"
            className="toolbar-grip"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              toolbarDrag.current = {
                pointerId: e.pointerId,
                start: { x: e.clientX, y: e.clientY },
                original: barPosition,
              };
            }}
            onPointerMove={(e) => {
              const g = toolbarDrag.current;
              if (g?.pointerId === e.pointerId)
                setToolbar({
                  x: g.original.x + e.clientX - g.start.x,
                  y: g.original.y + e.clientY - g.start.y,
                });
            }}
            onPointerUp={() => {
              toolbarDrag.current = null;
            }}
          >
            <GripVertical size={17} />
          </button>
          {tools.map(([id, label, Icon]) => (
            <Hint key={id} label={label}>
              <button
                aria-label={label}
                aria-pressed={tool === id}
                onClick={() => {
                  commitText();
                  setTool(id);
                }}
              >
                <Icon />
              </button>
            </Hint>
          ))}
          <span className="capture-separator" />
          <CaptureStylePicker
            label={`线宽：${width} 像素`}
            preview={
              <span
                className="capture-stroke-preview"
                style={{ height: Math.min(width, 7) }}
              />
            }
          >
            <strong>线宽</strong>
            {[2, 3, 5, 8].map((n) => (
              <Popover.Close key={n} asChild>
                <button
                  className="capture-width-option"
                  aria-label={`${n} 像素`}
                  aria-pressed={width === n}
                  onClick={() => setWidth(n)}
                >
                  <span style={{ height: n }} />
                  {n} px
                </button>
              </Popover.Close>
            ))}
          </CaptureStylePicker>
          <CaptureStylePicker
            label={`字号：${fontSize}`}
            preview={
              <>
                <CaseSensitive size={18} />
                <small>{fontSize}</small>
              </>
            }
          >
            <strong>字号</strong>
            <div className="capture-size-options">
              {[16, 20, 24, 32, 48].map((n) => (
                <Popover.Close key={n} asChild>
                  <button
                    aria-label={`字号 ${n}`}
                    aria-pressed={fontSize === n}
                    onClick={() => setFontSize(n)}
                  >
                    {n}
                  </button>
                </Popover.Close>
              ))}
            </div>
          </CaptureStylePicker>
          <CaptureStylePicker
            label="标注颜色"
            preview={
              <span
                className="capture-color-preview"
                style={{ background: color }}
              />
            }
          >
            <strong>颜色</strong>
            <div className="capture-color-options">
              {colors.map((c, i) => (
                <Hint
                  key={c}
                  label={["红色", "黄色", "绿色", "蓝色", "白色", "黑色"][i]}
                >
                  <Popover.Close
                    className="capture-color-swatch"
                    aria-label={
                      ["红色", "黄色", "绿色", "蓝色", "白色", "黑色"][i]
                    }
                    aria-pressed={color === c}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                  >
                    {color === c && (
                      <Check
                        size={14}
                        style={{
                          color:
                            c === "#ffffff" || c === "#facc15"
                              ? "#201e1c"
                              : "#fff",
                        }}
                      />
                    )}
                  </Popover.Close>
                </Hint>
              ))}
            </div>
          </CaptureStylePicker>
          <span className="capture-separator" />
          {(
            [
              ["撤销", Undo2, undo, !history.length],
              ["重做", Redo2, redoAction, !redo.length],
              [
                "重新框选",
                Crop,
                () => {
                  resetSelection();
                },
                false,
              ],
            ] as const
          ).map(([label, Icon, action, disabled]) => (
            <Hint key={label} label={label}>
              <button
                aria-label={label}
                disabled={disabled || busy}
                onClick={action}
              >
                <Icon size={18} />
              </button>
            </Hint>
          ))}
          {(
            [
              ["pin", "钉住截图", Pin],
              ["ocr", "提取文字", ScanText],
              ["translate", "翻译截图", Languages],
              ["attach", "发给 AI", ImagePlus],
              ["save", "保存 PNG", Download],
            ] as const
          ).map(([action, label, Icon]) => (
            <Hint key={action} label={label}>
              <button
                aria-label={label}
                disabled={busy}
                onClick={() => void finish(action)}
              >
                <Icon size={18} />
              </button>
            </Hint>
          ))}
          <Hint label="取消截图">
            <button
              className="capture-cancel"
              aria-label="取消截图"
              disabled={busy}
              onClick={() => void cancelCapture()}
            >
              <X size={21} />
            </button>
          </Hint>
          <Hint label="复制截图并完成（Enter）">
            <button
              className="capture-confirm"
              aria-label="复制截图并完成"
              disabled={busy}
              onClick={() => void finish("copy")}
            >
              <Check size={21} />
            </button>
          </Hint>
        </div>
      )}
      {(error || textOverflowMessage) && (
        <p className="capture-error desktop-error" role="alert">
          {error || textOverflowMessage}
        </p>
      )}
    </main>
  );
}
