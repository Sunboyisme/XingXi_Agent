import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
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
  MousePointer2,
  GripVertical,
  Crop,
  Eraser,
  ChevronDown,
  CaseSensitive,
} from "lucide-react";
import { Hint } from "./common";
import {
  invoke,
  emitTo,
  desktopListen,
  desktopError,
} from "@/lib/desktopAssistant";

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
  draftText: string;
};
type Gesture = {
  pointerId: number;
  start: Point;
  original?: Rect;
  handle?: string;
  mark?: Mark;
  erase?: boolean;
};
const rect = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});
const inside = (r: Rect, p: Point) =>
  p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h;
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
  ["move", "移动选区", MousePointer2],
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

function paint(
  ctx: CanvasRenderingContext2D,
  mark: Mark,
  source: HTMLCanvasElement,
) {
  const a = mark.points[0],
    b = mark.points.at(-1)!;
  ctx.save();
  ctx.strokeStyle = mark.color;
  ctx.fillStyle = mark.color;
  ctx.lineWidth = mark.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const r = rect(a, b);
  if (mark.tool === "text") {
    ctx.font = `${mark.size}px "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = "top";
    (mark.text || "")
      .split("\n")
      .forEach((line, i) => ctx.fillText(line, a.x, a.y + i * mark.size * 1.4));
  } else if (mark.tool === "mosaic" && r.w > 0 && r.h > 0) {
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.ceil(r.w / 12));
    small.height = Math.max(1, Math.ceil(r.h / 12));
    small
      .getContext("2d")!
      .drawImage(source, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, small.width, small.height, r.x, r.y, r.w, r.h);
  } else if (mark.tool === "rect") ctx.strokeRect(r.x, r.y, r.w, r.h);
  else if (mark.tool === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(
      r.x + r.w / 2,
      r.y + r.h / 2,
      r.w / 2,
      r.h / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    mark.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.stroke();
    if (mark.tool === "arrow") {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const size = Math.max(12, mark.width * 4);
      ctx.beginPath();
      ctx.moveTo(
        b.x - size * Math.cos(angle - 0.5),
        b.y - size * Math.sin(angle - 0.5),
      );
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(
        b.x - size * Math.cos(angle + 0.5),
        b.y - size * Math.sin(angle + 0.5),
      );
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function DesktopCapture() {
  const [session, setSession] = useState<Session>();
  const [selection, setSelection] = useState<Rect | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [redo, setRedo] = useState<Mark[][]>([]);
  const [history, setHistory] = useState<Mark[][]>([]);
  const [live, setLive] = useState<Mark | null>(null);
  const [eraseBox, setEraseBox] = useState<Rect | null>(null);
  const [tool, setTool] = useState<Tool>("move");
  const [color, setColor] = useState(colors[0]);
  const [width, setWidth] = useState(3);
  const [fontSize, setFontSize] = useState(24);
  const [text, setText] = useState<{ at: Point; value: string } | null>(null);
  const currentSession = useRef<Session | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
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
  const epoch = useRef(0);
  const exportLock = useRef(false);
  const commands = useRef({
    undo,
    redoAction,
    finish,
    commitText,
    cancelCapture,
    resetSelection,
  });
  commands.current = {
    undo,
    redoAction,
    finish,
    commitText,
    cancelCapture,
    resetSelection,
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
      const current = ++epoch.current;
      let active = false;
      setSelection(null);
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
        setSession(s);
        if (alive && current === epoch.current)
          await invoke("capture_present", { id: s.id });
      } catch (e) {
        if (alive && current === epoch.current && active) {
          setError(desktopError(e));
          await emitTo("quick", "desktop-error", desktopError(e));
          await invoke("capture_cancel", { id: loadingId });
        }
      }
    }
    const unlisten = desktopListen("capture-ready", () => void load());
    const dismissListener = desktopListen<string>("capture-dismiss", (id) => {
      if (currentSession.current?.id !== id) return;
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
    const resetListener = desktopListen<string>("capture-reset", (id) => {
      if (id === currentSession.current?.id) commands.current.resetSelection();
    });
    void Promise.all([unlisten, dismissListener, resetListener]).then(() => {
      if (alive) void load();
    });
    const resize = () => setViewport({ w: innerWidth, h: innerHeight });
    window.addEventListener("resize", resize);
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest(".capture-style-menu")) return;
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
      void resetListener.then((f) => f());
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
    const g = gesture.current;
    if (g && gestureTarget.current?.hasPointerCapture(g.pointerId))
      gestureTarget.current.releasePointerCapture(g.pointerId);
    gestureTarget.current = null;
    gesture.current = null;
    setSelection(null);
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
  }, [Boolean(text)]);
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
    ctx.fillStyle = "rgba(0,0,0,.38)";
    ctx.fillRect(0, 0, session.width, session.height);
    if (selection) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(selection.x, selection.y, selection.w, selection.h);
      ctx.clip();
      ctx.drawImage(source.current, 0, 0);
      marks.forEach((m) => paint(ctx, m, source.current!));
      if (live) paint(ctx, live, source.current);
      ctx.restore();
    }
  }, [session, selection, marks, live]);
  function addMark(mark: Mark) {
    setHistory((h) => [...h, marks]);
    setMarks((m) => [...m, mark]);
    setRedo([]);
  }
  function undo() {
    if (!history.length || exportLock.current) return;
    setRedo((r) => [...r, marks]);
    setMarks(history.at(-1)!);
    setHistory((h) => h.slice(0, -1));
  }
  function redoAction() {
    if (!redo.length || exportLock.current) return;
    setHistory((h) => [...h, marks]);
    setMarks(redo.at(-1)!);
    setRedo((r) => r.slice(0, -1));
  }
  function commitText() {
    if (!text) return;
    if (text.value.trim())
      addMark({
        tool: "text",
        points: [text.at],
        color,
        width,
        size: fontSize,
        text: text.value,
      });
    setText(null);
  }
  function point(e: ReactPointerEvent): Point {
    return {
      x: Math.max(0, Math.min(session?.width || 1, e.clientX / sx)),
      y: Math.max(0, Math.min(session?.height || 1, e.clientY / sy)),
    };
  }
  function begin(e: ReactPointerEvent, handle?: string) {
    if (!session || busy || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = point(e);
    if (!selection)
      void invoke("capture_select", { id: session.id }).catch((e) =>
        setError(desktopError(e)),
      );
    setError("");
    if (text) {
      commitText();
      return;
    }
    if (selection && tool === "erase" && !handle && inside(selection, p)) {
      gesture.current = { pointerId: e.pointerId, start: p, erase: true };
      setEraseBox({ ...p, w: 0, h: 0 });
      e.currentTarget.setPointerCapture(e.pointerId);
      gestureTarget.current = e.currentTarget;
      setDragging(true);
      return;
    }
    if (selection && tool === "text" && !handle && inside(selection, p)) {
      setText({ at: p, value: "" });
      return;
    }
    const original =
      selection &&
      (handle || tool === "move") &&
      inside(
        {
          x: selection.x - 15 / sx,
          y: selection.y - 15 / sy,
          w: selection.w + 30 / sx,
          h: selection.h + 30 / sy,
        },
        p,
      )
        ? { ...selection }
        : undefined;
    const mark =
      selection && !original && inside(selection, p)
        ? { tool, points: [p], color, width, size: fontSize }
        : undefined;
    gesture.current = {
      pointerId: e.pointerId,
      start: p,
      original,
      handle,
      mark,
    };
    if (!original && !mark) {
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
    setCursor({ x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g || !session || g.pointerId !== e.pointerId) return;
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
      else {
        let left = r.x,
          top = r.y,
          right = r.x + r.w,
          bottom = r.y + r.h;
        if (g.handle.includes("w"))
          left = Math.max(0, Math.min(right - 2, left + dx));
        if (g.handle.includes("e"))
          right = Math.min(session.width, Math.max(left + 2, right + dx));
        if (g.handle.includes("n"))
          top = Math.max(0, Math.min(bottom - 2, top + dy));
        if (g.handle.includes("s"))
          bottom = Math.min(session.height, Math.max(top + 2, bottom + dy));
        setSelection({ x: left, y: top, w: right - left, h: bottom - top });
      }
    } else if (g.mark) {
      g.mark.points =
        g.mark.tool === "pen" ? [...g.mark.points, p] : [g.start, p];
      setLive({ ...g.mark });
    } else setSelection(rect(g.start, p));
  }
  function end(e: ReactPointerEvent) {
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
      if (box.w < 2 || box.h < 2) {
        setSelection(null);
        void invoke("desktop_open", { capture: false }).catch((e) =>
          setError(desktopError(e)),
        );
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
    if (gesture.current?.pointerId !== e.pointerId) return;
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
      exportLock.current
    )
      return;
    const outputMarks = text?.value.trim()
      ? [
          ...marks,
          {
            tool: "text" as const,
            points: [text.at],
            color,
            width,
            size: fontSize,
            text: text.value,
          },
        ]
      : marks;
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
      await invoke("capture_export", {
        id: session.id,
        dataUrl: output.toDataURL("image/png"),
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
      {!selection && (
        <>
          <span
            className="capture-cursor-hint"
            style={{
              left: Math.min(viewport.w - 100, cursor.x + 18),
              top: Math.min(viewport.h - 45, cursor.y + 22),
            }}
          >
            拖拽截图
          </span>
        </>
      )}
      {selection && box && (
        <div
          className="capture-selection"
          style={box}
          onPointerDown={(e) => begin(e)}
        >
          <span className="capture-dimensions">
            {Math.round(selection.w)} × {Math.round(selection.h)}
          </span>
          {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => (
            <button
              key={h}
              className={`capture-handle handle-${h}`}
              aria-label={`调整截图范围 ${h}`}
              onPointerDown={(e) => begin(e, h)}
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
                    r && session
                      ? {
                          ...r,
                          x: Math.max(
                            0,
                            Math.min(session.width - r.w, r.x + dx),
                          ),
                          y: Math.max(
                            0,
                            Math.min(session.height - r.h, r.y + dy),
                          ),
                        }
                      : r,
                  );
                }
              }}
            />
          ))}
        </div>
      )}
      {text && (
        <textarea
          ref={textInput}
          className="capture-text"
          aria-label="截图文字"
          style={{
            left: text.at.x * sx,
            top: text.at.y * sy,
            color,
            fontSize: fontSize * sx,
          }}
          value={text.value}
          onChange={(e) => setText((t) => t && { ...t, value: e.target.value })}
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
                  void invoke("desktop_open", { capture: false }).catch((e) =>
                    setError(desktopError(e)),
                  );
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
              ["attach", "添加到问答草稿", ImagePlus],
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
      {error && (
        <p className="capture-error desktop-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
