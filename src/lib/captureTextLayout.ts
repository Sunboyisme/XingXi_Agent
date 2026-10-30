type Point = { x: number; y: number };
type Rect = Point & { w: number; h: number };

/** Keep typed text on the monitor and expand the crop immediately to include it. */
export function containCaptureText(
  crop: Rect,
  at: Point,
  size: { w: number; h: number },
  screen: { w: number; h: number },
) {
  const w = Math.min(screen.w, size.w),
    h = Math.min(screen.h, size.h);
  const x = Math.max(0, Math.min(at.x, screen.w - w));
  const y = Math.max(0, Math.min(at.y, screen.h - h));
  const left = Math.min(crop.x, x),
    top = Math.min(crop.y, y);
  return {
    at: { x, y },
    crop: {
      x: left,
      y: top,
      w: Math.min(screen.w, Math.max(crop.x + crop.w, x + w)) - left,
      h: Math.min(screen.h, Math.max(crop.y + crop.h, y + h)) - top,
    },
    overflow: size.w > screen.w || size.h > screen.h,
  };
}
