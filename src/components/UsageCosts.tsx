import { useLayoutEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { useUsageReport } from "@/lib/useUsageReport";
import { formatUsageAmount, usageDateBefore } from "@/lib/usageCosts";
import { DateTimePicker } from "./DateTimePicker";
import { Button } from "./ui/button";
import { SoftSelect } from "./ui/soft-select";
import { ModelPricing } from "./usage/ModelPricing";
import { UsageRecords } from "./usage/UsageRecords";
import "@/styles/usage-costs.css";

export function UsageCosts() {
  const [start, setStart] = useState(() => usageDateBefore(29));
  const [end, setEnd] = useState(() => usageDateBefore(0));
  const [range, setRange] = useState("30");
  const [callPage, setCallPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [pricingOpen, setPricingOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pricingTrigger = useRef<HTMLButtonElement>(null);
  const reportScroll = useRef(0);
  const switchingPage = useRef(false);
  const { report, loading, error } = useUsageReport(
    start,
    end,
    callPage,
    revision,
  );
  function showPricing(open: boolean) {
    const scroller = root.current?.closest<HTMLElement>(".settings-content, .page-body");
    if (open) reportScroll.current = scroller?.scrollTop || 0;
    switchingPage.current = true;
    setPricingOpen(open);
  }
  useLayoutEffect(() => {
    if (!switchingPage.current) return;
    const scroller = root.current?.closest<HTMLElement>(".settings-content, .page-body");
    if (scroller) scroller.scrollTop = pricingOpen ? 0 : reportScroll.current;
    if (!pricingOpen) pricingTrigger.current?.focus({ preventScroll: true });
    switchingPage.current = false;
  }, [pricingOpen]);
  function changeCallPage(page: number) {
    if (callPage === page) setRevision((value) => value + 1);
    else setCallPage(page);
  }
  return (
    <div className="usage-costs" ref={root}>
      {pricingOpen && <ModelPricing onBack={() => showPricing(false)} />}
      <div className="usage-report" hidden={pricingOpen}>
        <header className="usage-heading">
          <div>
            <span className="usage-eyebrow">模型用量</span>
            <h2>用量与估算费用</h2>
            <p>
              统计 XiaoXi
              可观测的模型调用。费用为估算值，第三方工具内部消费不包含在内。
            </p>
          </div>
          <Button
            ref={pricingTrigger}
            variant="outline"
            size="sm"
            onClick={() => showPricing(true)}
          >
            <Settings2 size={15} />
            模型单价
          </Button>
        </header>
        <div className="usage-filters">
          <div className="usage-date-field usage-range-field">
            <label htmlFor="usage-range">日期范围</label>
            <SoftSelect
              id="usage-range"
              label="费用日期范围"
              value={range}
              onValueChange={(value) => {
                setRange(value);
                setCallPage(1);
                if (value !== "custom") {
                  setStart(usageDateBefore(Number(value) - 1));
                  setEnd(usageDateBefore(0));
                }
              }}
              options={[
                { value: "1", label: "今日" },
                { value: "7", label: "近七天" },
                { value: "30", label: "近三十天" },
                { value: "custom", label: "自定义" },
              ]}
            />
          </div>
          <div className="usage-date-field">
            <label htmlFor="usage-start">开始日期</label>
            <DateTimePicker
              id="usage-start"
              dateOnly
              label="开始日期"
              value={start}
              onChange={(value) => {
                setStart(value);
                setRange("custom");
                setCallPage(1);
              }}
            />
          </div>
          <div className="usage-date-field">
            <label htmlFor="usage-end">结束日期</label>
            <DateTimePicker
              id="usage-end"
              dateOnly
              label="结束日期"
              value={end}
              onChange={(value) => {
                setEnd(value);
                setRange("custom");
                setCallPage(1);
              }}
            />
          </div>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新
          </Button>
        </div>
        {error && (
          <div className="usage-load-error" role="alert">
            <p>{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRevision((value) => value + 1)}
            >
              重新读取
            </Button>
          </div>
        )}
        {report && (
          <>
            <div className="usage-stats" aria-label="用量概览">
              <div className="usage-stat">
                <span>模型调用</span>
                <strong>
                  {report.total_calls.toLocaleString("zh-CN")}
                  <small>次</small>
                </strong>
                <p>所选日期内的调用总数</p>
              </div>
              <div className="usage-stat">
                <span>总计 Token 数</span>
                <strong>{report.total_tokens?.toLocaleString("zh-CN") ?? "—"}</strong>
                <p>{report.unknown_token_calls > 0
                  ? `${report.unknown_token_calls} 次调用未返回完整用量，仅合计已知值`
                  : "所选日期的已记录用量，含去重后的旧记录"}</p>
              </div>
              <div className="usage-stat usage-stat-cost">
                <span>已知估算费用</span>
                {Object.entries(report.currencies).length ? (
                  Object.entries(report.currencies).map(([code, cost]) => (
                    <strong key={code}>
                      <small>{code}</small>
                      {formatUsageAmount(cost)}
                    </strong>
                  ))
                ) : (
                  <strong>—</strong>
                )}
                <p>仅统计价格与用量齐全的调用</p>
              </div>
            </div>
            {report.unknown_calls > 0 && (
              <p className="usage-unknown-note">
                {report.unknown_calls} 次调用费用待定，尚未计入费用总额。缺少调用时的单价或完整用量时无法估算，可查看调用明细中的原因。
              </p>
            )}
          </>
        )}
        <UsageRecords
          report={report}
          loading={loading}
          onCallPageChange={changeCallPage}
          rangeKey={`${start}|${end}`}
        />
      </div>
    </div>
  );
}
