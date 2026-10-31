export type CaptureTool =
  | "select"
  | "move"
  | "pen"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text"
  | "mosaic"
  | "erase";
export type CapturePoint = { x: number; y: number };
export type CaptureMark = {
  tool: CaptureTool;
  points: CapturePoint[];
  color: string;
  width: number;
  size: number;
  text?: string;
};
const rect = (a: CapturePoint, b: CapturePoint) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(b.x - a.x),
  h: Math.abs(b.y - a.y),
});

export function paintCaptureMark(
  ctx: CanvasRenderingContext2D,
  mark: CaptureMark,
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
    const right = Math.min(source.width, r.x + r.w), bottom = Math.min(source.height, r.y + r.h);
    r.x = Math.max(0, r.x); r.y = Math.max(0, r.y); r.w = right - r.x; r.h = bottom - r.y;
    if (r.w <= 0 || r.h <= 0) { ctx.restore(); return; }
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
