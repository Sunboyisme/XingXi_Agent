import { useRef } from "react";

export function SidebarResize({
  width,
  onChange,
}: {
  width: number;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) =>
    Math.max(180, Math.min(420, window.innerWidth - 456, value));
  return (
    <div
      className="sidebar-resize"
      role="separator"
      aria-label="调整聊天侧栏宽度"
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuemin={180}
      aria-valuemax={420}
      aria-valuenow={width}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current)
          onChange(clamp(drag.current.width + event.clientX - drag.current.x));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onChange(224)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        onChange(
          clamp(
            event.key === "Home"
              ? 180
              : event.key === "End"
                ? 420
                : width + (event.key === "ArrowLeft" ? -16 : 16),
          ),
        );
      }}
    />
  );
}
