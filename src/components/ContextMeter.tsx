import { Tooltip } from "radix-ui";

export type ContextUsage = {
  used_tokens?: number;
  limit_tokens?: number;
  reserved_tokens?: number;
  provider_id?: string;
  model_name?: string;
};

export function ContextMeter({
  usage,
  limit,
  compacting,
  onSettings,
}: {
  usage: ContextUsage | null;
  limit: number;
  compacting: boolean;
  onSettings: () => void;
}) {
  const used = usage?.used_tokens;
  const reserved =
    usage?.reserved_tokens ??
    Math.min(8192, Math.max(1024, Math.floor(limit / 8)));
  const percent = used === undefined ? 0 : Math.round((100 * used) / limit);
  const high = used !== undefined && (used + reserved) / limit >= 0.9;
  const format = (tokens: number) => tokens.toLocaleString("zh-CN");
  const label = compacting
    ? "正在整理上下文"
    : used === undefined
      ? `上下文窗口，总额度 ${format(limit)} token。点击调整当前模型的上下文设置。`
      : `上下文约 ${percent}% 已用，已用 ${format(used)} token，共 ${format(limit)} token。点击调整当前模型的上下文设置。`;
  return (
    <Tooltip.Provider delayDuration={180} skipDelayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`context-meter ${high ? "is-high" : ""} ${compacting ? "is-compacting" : ""}`}
            aria-label={label}
            onClick={onSettings}
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
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="context-meter-popover"
            side="top"
            sideOffset={10}
            collisionPadding={12}
          >
            <span className="context-meter-heading">上下文窗口</span>
            {(compacting || used !== undefined) && (
              <span className="context-meter-percent">
                {compacting ? "正在整理上下文…" : `约 ${percent}% 已用`}
              </span>
            )}
            <strong>
              {used === undefined
                ? `总额度 ${format(limit)} token`
                : `已用 ${format(used)} token，共 ${format(limit)}`}
            </strong>
            <Tooltip.Arrow className="context-meter-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
