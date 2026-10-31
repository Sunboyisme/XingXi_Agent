import type { CaptureMark, CapturePoint } from "./captureDrawing";
import type { CaptureScene } from "./commonTextDocument";
export type CaptureBounds = { x: number; y: number; w: number; h: number };

export function captureMarkBounds(
  mark: CaptureMark,
  context?: CanvasRenderingContext2D,
): CaptureBounds {
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
  if (mark.tool === "text") {
    if (context) context.font = `${mark.size}px "Microsoft YaHei", sans-serif`;
    const lines = (mark.text || "").split("\n");
    return {
      ...mark.points[0],
      w: Math.max(
        2,
        ...lines.map((line) =>
          context ? context.measureText(line).width : line.length * mark.size,
        ),
      ),
      h: Math.max(2, lines.length * mark.size * 1.4),
    };
  }
  const padding = Math.max(mark.width / 2, mark.tool === "arrow" ? 12 : 2);
  return {
    x: left - padding,
    y: top - padding,
    w: Math.max(2, right - left + padding * 2),
    h: Math.max(2, bottom - top + padding * 2),
  };
}

export function transformCaptureMark(
  mark: CaptureMark,
  from: CaptureBounds,
  to: CaptureBounds,
): CaptureMark {
  const xScale = to.w / from.w,
    yScale = to.h / from.h;
  return {
    ...mark,
    points: mark.points.map((p) => ({
      x: to.x + (p.x - from.x) * xScale,
      y: to.y + (p.y - from.y) * yScale,
    })),
    size:
      mark.tool === "text"
        ? Math.min(512, Math.max(1, mark.size * Math.min(xScale, yScale)))
        : mark.size,
  };
}

export function constrainedCapturePoint(
  start: CapturePoint,
  end: CapturePoint,
  tool: string,
  shift: boolean,
): CapturePoint {
  if (!shift || !["rect", "ellipse"].includes(tool)) return end;
  const size = Math.min(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
  return {
    x: start.x + Math.sign(end.x - start.x) * size,
    y: start.y + Math.sign(end.y - start.y) * size,
  };
}

export function cropCaptureScene(
  marks: CaptureMark[],
  bounds: CaptureBounds,
  context?: CanvasRenderingContext2D,
): CaptureScene {
  return {
    version: 1,
    width: Math.round(bounds.w),
    height: Math.round(bounds.h),
    marks: marks
      .filter((mark) =>
        ["pen", "line", "arrow", "rect", "ellipse", "text", "mosaic"].includes(
          mark.tool,
        ),
      )
      .filter((mark) => {
        const b = captureMarkBounds(mark, context);
        return (
          b.x < bounds.x + bounds.w &&
          b.x + b.w > bounds.x &&
          b.y < bounds.y + bounds.h &&
          b.y + b.h > bounds.y
        );
      })
      .map((mark) => ({
        ...mark,
        points: mark.points.map((p) => ({
          x: p.x - bounds.x,
          y: p.y - bounds.y,
        })),
      })),
  };
}
