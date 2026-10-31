import "../styles/capture-objects.css";
import {
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent,
} from "react";
import type { CaptureMark, CapturePoint } from "@/lib/captureDrawing";
import {
  captureMarkBounds,
  transformCaptureMark,
  type CaptureBounds,
} from "@/lib/captureScene";

/** Object gestures are shared by full-screen capture and saved-image editing. */
export function CaptureObjects({
  marks,
  selected,
  onSelect,
  onPreview,
  onCommit,
  point,
  styleRect,
  context,
  onEditText,
}: {
  marks: CaptureMark[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  onPreview: (marks: CaptureMark[]) => void;
  onCommit: (before: CaptureMark[], after: CaptureMark[]) => void;
  point: (event: PointerEvent) => CapturePoint;
  styleRect: (bounds: CaptureBounds) => CSSProperties;
  context?: CanvasRenderingContext2D;
  onEditText: (index: number) => void;
}) {
  const gesture = useRef<{
    pointer: number;
    target: HTMLElement;
    index: number;
    start: CapturePoint;
    corner?: string;
    bounds: CaptureBounds;
    before: CaptureMark[];
    after: CaptureMark[];
  } | null>(null);
  useEffect(() => {
    const cancel = () => {
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;
      if (g.target.hasPointerCapture(g.pointer))
        g.target.releasePointerCapture(g.pointer);
      onPreview(g.before);
    };
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [onPreview]);
  function begin(
    event: PointerEvent<HTMLElement>,
    index: number,
    corner?: string,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(index);
    event.currentTarget.focus();
    gesture.current = {
      pointer: event.pointerId,
      target: event.currentTarget,
      index,
      corner,
      start: point(event),
      bounds: captureMarkBounds(marks[index], context),
      before: marks,
      after: marks,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function finish(event: PointerEvent<HTMLElement>, cancel = false) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = null;
    if (g.target.hasPointerCapture(event.pointerId))
      g.target.releasePointerCapture(event.pointerId);
    if (cancel) onPreview(g.before);
    else if (JSON.stringify(g.before) !== JSON.stringify(g.after))
      onCommit(g.before, g.after);
  }
  return (
    <div className="capture-object-layer">
      {marks.map((mark, index) => {
        const bounds = captureMarkBounds(mark, context);
        return (
          <div
            key={index}
            className="capture-object"
            data-selected={selected === index || undefined}
            style={styleRect(bounds)}
            tabIndex={0}
            role="button"
            aria-label={`选择${mark.tool === "text" ? "文字" : "图形"}标注 ${index + 1}`}
            onFocus={() => onSelect(index)}
            onPointerDown={(event) => begin(event, index)}
            onPointerMove={(event) => {
              const g = gesture.current;
              if (!g || g.pointer !== event.pointerId) return;
              event.stopPropagation();
              event.preventDefault();
              const p = point(event),
                dx = p.x - g.start.x,
                dy = p.y - g.start.y,
                b = g.bounds;
              const next = { ...b };
              if (!g.corner) {
                next.x += dx;
                next.y += dy;
              } else {
                if (g.corner.includes("w")) {
                  next.x += Math.min(dx, b.w - 2);
                  next.w = b.x + b.w - next.x;
                }
                if (g.corner.includes("e")) next.w = Math.max(2, b.w + dx);
                if (g.corner.includes("n")) {
                  next.y += Math.min(dy, b.h - 2);
                  next.h = b.y + b.h - next.y;
                }
                if (g.corner.includes("s")) next.h = Math.max(2, b.h + dy);
              }
              g.after = g.before.map((value, i) =>
                i === g.index ? transformCaptureMark(value, b, next) : value,
              );
              onPreview(g.after);
            }}
            onPointerUp={(event) => finish(event)}
            onPointerCancel={(event) => finish(event, true)}
            onLostPointerCapture={(event) => finish(event, true)}
            onDoubleClick={(event) => {
              event.stopPropagation();
              if (mark.tool === "text") onEditText(index);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onSelect(null);
                return;
              }
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "z"
              )
                return;
              const delta = event.shiftKey ? 10 : 1;
              const dx =
                event.key === "ArrowLeft"
                  ? -delta
                  : event.key === "ArrowRight"
                    ? delta
                    : 0;
              const dy =
                event.key === "ArrowUp"
                  ? -delta
                  : event.key === "ArrowDown"
                    ? delta
                    : 0;
              if (
                dx ||
                dy ||
                ["Delete", "Backspace", "Enter"].includes(event.key)
              ) {
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Enter") {
                  if (mark.tool === "text") onEditText(index);
                  return;
                }
                if (["Delete", "Backspace"].includes(event.key)) {
                  onCommit(
                    marks,
                    marks.filter((_, i) => i !== index),
                  );
                  onSelect(null);
                } else
                  onCommit(
                    marks,
                    marks.map((value, i) =>
                      i === index
                        ? transformCaptureMark(value, bounds, {
                            ...bounds,
                            x: bounds.x + dx,
                            y: bounds.y + dy,
                          })
                        : value,
                    ),
                  );
              }
            }}
          >
            {selected === index &&
              ["nw", "ne", "se", "sw"].map((corner) => (
                <span
                  key={corner}
                  className={`capture-object-corner corner-${corner}`}
                  onPointerDown={(event) => begin(event, index, corner)}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}
