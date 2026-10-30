import { expect, test } from "vitest";
import { containCaptureText } from "./captureTextLayout";

test("typing beyond the crop grows it without moving text that still fits the monitor", () => {
  expect(
    containCaptureText(
      { x: 100, y: 100, w: 200, h: 80 },
      { x: 160, y: 145 },
      { w: 150, h: 120 },
      { w: 1000, h: 700 },
    ),
  ).toEqual({
    at: { x: 160, y: 145 },
    crop: { x: 100, y: 100, w: 210, h: 165 },
    overflow: false,
  });
});
test("screen edges move the editor inward and keep both original crop and text", () => {
  expect(
    containCaptureText(
      { x: 850, y: 600, w: 150, h: 100 },
      { x: 950, y: 675 },
      { w: 120, h: 80 },
      { w: 1000, h: 700 },
    ),
  ).toEqual({
    at: { x: 880, y: 620 },
    crop: { x: 850, y: 600, w: 150, h: 100 },
    overflow: false,
  });
});
test("oversized text is reported instead of silently exporting clipped content", () => {
  const layout = containCaptureText(
    { x: 400, y: 500, w: 300, h: 100 },
    { x: 500, y: 550 },
    { w: 200, h: 1100 },
    { w: 1000, h: 700 },
  );
  expect(layout.overflow).toBe(true);
  expect(layout.at).toEqual({ x: 500, y: 0 });
  expect(layout.crop).toEqual({ x: 400, y: 0, w: 300, h: 700 });
});
