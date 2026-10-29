import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import {
  type UsageCall,
  type UsageGroup,
  type UsageReport,
  USAGE_PAGE_SIZE,
  formatUsageAmount,
  usagePurposes,
  usageStates,
} from "@/lib/usageCosts";
import { Button } from "../ui/button";
import { SoftSelect } from "../ui/soft-select";
import { DetailDialog } from "../ui/detail-dialog";
import { HintText } from "../ui/hint";

type View = "summary" | "calls" | "history";
function Metric({ value, unknown = 0, calls = 0 }: { value: number; unknown?: number; calls?: number }) {
  return (
    <>
      {unknown > 0 && unknown === calls ? "—" : value.toLocaleString("zh-CN")}
      {unknown > 0 && (
        <HintText as="small" label={`${unknown} 次调用未返回此项用量`}>
          （{unknown} 次未返回）
        </HintText>
      )}
    </>
  );
}
function Pagination({
  total,
  page,
  loading,
  onChange,
  note,
}: {
  total: number;
  page: number;
  loading: boolean;
  onChange: (page: number) => void;
  note?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / USAGE_PAGE_SIZE));
  const first = total ? (page - 1) * USAGE_PAGE_SIZE + 1 : 0;
  return (
    <footer className="usage-pagination">
      <span>
        {note || `共 ${total.toLocaleString("zh-CN")} 条`}
        <small>
          {first}–{Math.min(page * USAGE_PAGE_SIZE, total)} 条 · 每页{" "}
          {USAGE_PAGE_SIZE} 条
        </small>
      </span>
      <nav aria-label="记录分页">
        <Button
          size="icon"
          variant="ghost"
          aria-label="上一页"
          disabled={loading || page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={16} />
        </Button>
        <span aria-live="polite">
          <strong>{page}</strong> / {pages}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="下一页"
          disabled={loading || page >= pages}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={16} />
        </Button>
      </nav>
    </footer>
  );
}
function SummaryTable({ groups }: { groups: UsageGroup[] }) {
  return (
    <table>
      <thead>
        <tr>
          {[
            "连接 / 模型",
            "用途",
            "调用",
            "输入 Token",
            "输出 Token",
            "缓存读 / 写",
            "图片",
            "已知费用",
            "费用待定调用（次）",
          ].map((label) => (
            <th scope="col" key={label}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((row) => (
          <tr
            key={JSON.stringify([
              row.provider_id,
              row.model_name,
              row.purpose,
              row.currency,
            ])}
          >
            <td className="usage-model">
              <strong>{row.provider_label}</strong>
              <HintText as="small" label={row.model_name}>{row.model_name}</HintText>
            </td>
            <td>{usagePurposes[row.purpose] || row.purpose}</td>
            <td>{row.calls}</td>
            <td>
              <Metric
                value={row.input_tokens}
                unknown={row.unknown_input_calls}
                calls={row.calls}
              />
            </td>
            <td>
              <Metric
                value={row.output_tokens}
                unknown={row.unknown_output_calls}
                calls={row.calls}
              />
            </td>
            <td>
              <Metric
                value={row.cached_tokens}
                unknown={row.unknown_cached_calls}
                calls={row.calls}
              />{" "}
              /{" "}
              <Metric
                value={row.cache_write_tokens}
                unknown={row.unknown_cache_write_calls}
                calls={row.calls}
              />
            </td>
            <td>
              {row.kind === "images" ? (
                <Metric
                  value={row.image_count}
                  unknown={row.unknown_image_calls}
                calls={row.calls}
                />
              ) : (
                "—"
              )}
            </td>
            <td>
              {row.currency && row.known_calls > 0
                ? `${row.currency} ${formatUsageAmount(row.known_cost)}`
                : "未知"}
            </td>
            <HintText as="td" label="未计入费用总额的调用次数；可在调用明细查看缺少单价或用量的原因">{row.unknown_calls || "—"}</HintText>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function CallsTable({ calls }: { calls: UsageCall[] }) {
  return (
    <table>
      <thead>
        <tr>
          {[
            "时间",
            "连接 / 模型",
            "用途 / 状态",
            "输入 / 输出",
            "缓存读 / 写",
            "图片",
            "估算费用",
          ].map((label) => (
            <th scope="col" key={label}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {calls.map((row) => (
          <tr key={row.id}>
            <td className="usage-time">
              <time dateTime={row.created_at}>
                {new Date(row.created_at).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </time>
            </td>
            <td className="usage-model">
              <strong>{row.provider_label}</strong>
              <HintText as="small" label={row.model_name}>{row.model_name}</HintText>
            </td>
            <td>
              <span>{usagePurposes[row.purpose] || row.purpose}</span>
              <small className="usage-call-state" data-status={row.status}>
                {usageStates[row.status] || row.status}
              </small>
            </td>
            <td>
              {row.input_tokens?.toLocaleString("zh-CN") ?? "未知"} /{" "}
              {row.output_tokens?.toLocaleString("zh-CN") ?? "未知"}
            </td>
            <td>
              {row.cached_tokens?.toLocaleString("zh-CN") ?? "—"} /{" "}
              {row.cache_write_tokens?.toLocaleString("zh-CN") ?? "—"}
            </td>
            <td>{row.image_count ?? "—"}</td>
            <td>
              {row.estimated_cost !== null ? (
                `${row.price_snapshot.currency || ""} ${formatUsageAmount(row.estimated_cost)}`
              ) : (
                <span className="usage-cost-reason">
                  <DetailDialog
                    title="本次费用说明"
                    label={
                      <>
                        <span>未知</span>
                        <Info size={12} />
                      </>
                    }
                  >
                    <p>
                      {row.unknown_reason ||
                        "服务商用量或模型单价不完整，暂时无法估算。"}
                    </p>
                    <p className="muted">
                      {row.provider_label} · {row.model_name} ·{" "}
                      {new Date(row.created_at).toLocaleString("zh-CN")}
                    </p>
                  </DetailDialog>
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function HistoryTable({ rows }: { rows: UsageReport["historical"] }) {
  return (
    <table>
      <thead>
        <tr>
          {["时间", "总 Token", "费用状态", "说明"].map((label) => (
            <th scope="col" key={label}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <time dateTime={row.created_at}>
                {new Date(row.created_at).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </time>
            </td>
            <td>{row.total_tokens.toLocaleString("zh-CN")}</td>
            <td>未知</td>
            <HintText as="td" className="usage-note-cell" label={row.unknown_reason}>
              {row.unknown_reason || "旧记录缺少详细用量"}
            </HintText>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UsageRecords({
  report,
  loading,
  onCallPageChange,
  rangeKey,
}: {
  report: UsageReport | null;
  loading: boolean;
  onCallPageChange: (page: number) => void;
  rangeKey: string;
}) {
  const [view, setView] = useState<View>("summary");
  const [summarySort, setSummarySort] = useState("calls");
  const [pages, setPages] = useState({ summary: 1, history: 1 });
  const root = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const savedScroll = useRef<{
    element: HTMLElement;
    top: number;
    left: number;
  } | null>(null);
  const groups = [...(report?.groups || [])].sort(
    (a, b) =>
      (summarySort === "calls" ? b.calls - a.calls : 0) ||
      a.provider_label.localeCompare(b.provider_label, "zh-CN") ||
      a.model_name.localeCompare(b.model_name) ||
      a.purpose.localeCompare(b.purpose),
  );
  const count =
    view === "summary"
      ? groups.length
      : view === "calls"
        ? report?.total_calls || 0
        : report?.historical.length || 0;
  const page =
    view === "calls"
      ? Math.floor((report?.offset || 0) / USAGE_PAGE_SIZE) + 1
      : Math.min(pages[view], Math.max(1, Math.ceil(count / USAGE_PAGE_SIZE)));
  const start = (page - 1) * USAGE_PAGE_SIZE;
  const tabs: { value: View; label: string; count?: number }[] = [
    { value: "summary", label: "模型汇总" },
    { value: "calls", label: "调用明细", count: report?.total_calls },
    { value: "history", label: "历史记录", count: report?.historical_count },
  ];
  useEffect(() => {
    setPages({ summary: 1, history: 1 });
  }, [rangeKey]);
  function changeView(value: View) {
    if (value === view) return;
    const element = root.current?.closest<HTMLElement>(".settings-content, .page-body");
    if (element)
      savedScroll.current = {
        element,
        top: element.scrollTop,
        left: element.scrollLeft,
      };
    setView(value);
  }
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
    const saved = savedScroll.current;
    if (saved) {
      saved.element.scrollTop = saved.top;
      saved.element.scrollLeft = saved.left;
      savedScroll.current = null;
    }
  }, [view, page, summarySort, rangeKey]);
  function changePage(next: number) {
    if (view === "calls") onCallPageChange(next);
    else setPages((current) => ({ ...current, [view]: next }));
  }
  return (
    <section className="usage-records" ref={root} aria-busy={loading}>
      <div className="usage-records-heading">
        <h3>用量记录</h3>
        {view === "summary" ? (
          <SoftSelect
            label="汇总排序"
            value={summarySort}
            onValueChange={(value) => {
              setSummarySort(value);
              setPages((current) => ({ ...current, summary: 1 }));
            }}
            options={[
              { value: "calls", label: "调用次数优先" },
              { value: "model", label: "按连接与模型" },
            ]}
          />
        ) : (
          <span>最新在前{loading ? " · 正在读取…" : ""}</span>
        )}
      </div>
      <div
        className="usage-record-tabs"
        role="tablist"
        aria-label="用量记录视图"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`usage-tab-${tab.value}`}
            aria-controls={`usage-panel-${tab.value}`}
            aria-selected={view === tab.value}
            tabIndex={view === tab.value ? 0 : -1}
            onMouseDown={(event) => {
              if (event.button === 0) {
                event.preventDefault();
                event.currentTarget.focus({ preventScroll: true });
              }
            }}
            onClick={() => changeView(tab.value)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (index +
                        (event.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                      tabs.length;
              changeView(tabs[next].value);
              document
                .getElementById(`usage-tab-${tabs[next].value}`)
                ?.focus({ preventScroll: true });
            }}
          >
            {tab.label}
            {tab.count !== undefined && <span>{tab.count}</span>}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.value}
          className="usage-record-body"
          role="tabpanel"
          id={`usage-panel-${tab.value}`}
          aria-labelledby={`usage-tab-${tab.value}`}
          hidden={view !== tab.value}
        >
          {view === tab.value && (
            <>
              <div className="usage-table-scroll" ref={viewport}>
                {!report ? (
                  <p className="usage-empty" role="status">
                    {loading ? "正在读取用量…" : "暂无用量记录"}
                  </p>
                ) : view === "summary" ? (
                  <SummaryTable
                    groups={groups.slice(start, start + USAGE_PAGE_SIZE)}
                  />
                ) : view === "calls" ? (
                  <CallsTable calls={report.calls} />
                ) : (
                  <HistoryTable
                    rows={report.historical.slice(
                      start,
                      start + USAGE_PAGE_SIZE,
                    )}
                  />
                )}
                {report && count === 0 && (
                  <p className="usage-empty">
                    所选日期内暂无
                    {tabs.find((tab) => tab.value === view)?.label}。
                  </p>
                )}
              </div>
              <Pagination
                total={count}
                page={page}
                loading={loading}
                onChange={changePage}
                note={
                  view === "history" &&
                  report &&
                  report.historical_count > count
                    ? `显示最近 ${count} 条，共 ${report.historical_count} 条历史记录`
                    : undefined
                }
              />
            </>
          )}
        </div>
      ))}
    </section>
  );
}
