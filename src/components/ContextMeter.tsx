import { Hint } from "./ui/hint";

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
}: {
  usage: ContextUsage | null;
  limit: number;
  compacting: boolean;
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
    : `上下文用量，${used === undefined ? "尚无用量统计，" : `已用 ${format(used)} token，约 ${percent}%，`}总额度 ${format(limit)} token。`;
  return (
    <Hint
      label={
        <>
          <strong>上下文用量</strong>
          {compacting && <span>正在整理上下文…</span>}
          {used !== undefined && (
            <span>
              已用 {format(used)} token · 约 {percent}%
            </span>
          )}
          <span>总额度 {format(limit)} token</span>
        </>
      }
    >
      <span
        tabIndex={0}
        role="img"
        aria-label={label}
        className={`context-meter ${high ? "is-high" : ""} ${compacting ? "is-compacting" : ""}`}
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
      </span>
    </Hint>
  );
}
