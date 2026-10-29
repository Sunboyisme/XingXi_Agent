import { Popover, RadioGroup } from "radix-ui";
import type { HoverPopover } from "@/lib/useHoverPopover";
import { contextCapacities } from "./ContextCapacityInput";

export type ContextUsage = {
  used_tokens?: number;
  limit_tokens?: number;
  reserved_tokens?: number;
  provider_id?: string;
  model_name?: string;
};

export function ContextMeter({
  menu,
  onOpen,
  usage,
  limit,
  defaultLimit,
  contextOverride,
  compacting,
  disabled = false,
  onCapacity,
}: {
  menu: HoverPopover;
  onOpen: () => void;
  usage: ContextUsage | null;
  limit: number;
  defaultLimit: number;
  contextOverride?: number;
  compacting: boolean;
  disabled?: boolean;
  onCapacity: (tokens?: number) => void;
}) {
  function showCapacity() {
    onOpen();
    menu.show();
  }
  const used = usage?.used_tokens;
  const reserved =
    usage?.reserved_tokens ??
    Math.min(8192, Math.max(1024, Math.floor(limit / 8)));
  const percent = used === undefined ? 0 : Math.round((100 * used) / limit);
  const high = used !== undefined && (used + reserved) / limit >= 0.9;
  const format = (tokens: number) => tokens.toLocaleString("zh-CN");
  const capacityLabel = (tokens: number) =>
    tokens >= 1000000 ? `${tokens / 1000000}M` : `${tokens / 1000}k`;
  const label = compacting
    ? "正在整理上下文"
    : `上下文窗口，${used === undefined ? "" : `已用约 ${percent}%，`}总额度 ${format(limit)} token。悬停或聚焦选择上下文大小。`;
  const capacities =
    contextOverride !== undefined &&
    !contextCapacities.includes(contextOverride)
      ? [...contextCapacities, contextOverride].sort((a, b) => a - b)
      : contextCapacities;
  return (
    <Popover.Root open={menu.open} onOpenChange={menu.onOpenChange}>
      <Popover.Trigger asChild>
        <button
          ref={menu.trigger}
          type="button"
          disabled={disabled}
          className={`context-meter ${high ? "is-high" : ""} ${compacting ? "is-compacting" : ""}`}
          aria-label={label}
          onPointerEnter={showCapacity}
          onPointerLeave={menu.scheduleClose}
          onFocus={() => {
            onOpen();
            menu.onFocus();
          }}
          onBlur={menu.onBlur}
          onClick={(event) => {
            event.preventDefault();
            showCapacity();
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle className="context-meter-track" cx="10" cy="10" r="7" />
            <circle
              className="context-meter-value"
              cx="10"
              cy="10"
              r="7"
              pathLength="100"
              strokeDasharray={`${Math.min(100, percent)} 100`}
            />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={menu.content}
          className="context-size-menu"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="上下文大小"
          onPointerEnter={menu.cancelClose}
          onPointerLeave={menu.scheduleClose}
          onFocusCapture={menu.cancelClose}
          onBlurCapture={menu.onBlur}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            menu.closeAndFocus();
          }}
        >
          <div className="context-size-heading">
            <strong>上下文大小</strong>
            <span>仅当前对话</span>
          </div>
          <p className="context-size-usage">
            {compacting
              ? "正在整理上下文…"
              : used === undefined
                ? `总额度 ${format(limit)} token`
                : `已用 ${format(used)} / ${format(limit)} token · 约 ${percent}%`}
          </p>
          <RadioGroup.Root
            className="context-size-options"
            aria-label="选择上下文容量"
            value={
              contextOverride === undefined
                ? "default"
                : String(contextOverride)
            }
            disabled={disabled}
            onValueChange={(value) => {
              onCapacity(value === "default" ? undefined : Number(value));
              menu.closeAndFocus();
            }}
          >
            <RadioGroup.Item value="default" className="context-size-default">
              模型默认 · {capacityLabel(defaultLimit)}
            </RadioGroup.Item>
            {capacities.map((tokens) => (
              <RadioGroup.Item key={tokens} value={String(tokens)}>
                {capacityLabel(tokens)}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
