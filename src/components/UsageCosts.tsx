import { SoftSelect } from "./ui/soft-select";
import { DetailDialog } from "./ui/detail-dialog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { DateTimePicker } from "./DateTimePicker";
import { Button } from "./ui/button";
import "@/styles/usage-costs.css";

type Model = {
  provider_id: string;
  provider_label: string;
  model_name: string;
  kind: string;
};
type Price = Model & {
  id: string;
  created_at: string;
  currency: string;
  image_size: string;
  rates: Record<string, string>;
};
type Call = Model & {
  id: string;
  created_at: string;
  purpose: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  image_count: number | null;
  estimated_cost: string | null;
  unknown_reason: string;
  price_snapshot: { currency?: string };
};
type Group = Model & {
  purpose: string;
  currency: string | null;
  calls: number;
  unknown_calls: number;
  known_calls: number;
  unknown_input_calls: number;
  unknown_output_calls: number;
  unknown_image_calls: number;
  unknown_cached_calls: number;
  unknown_cache_write_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  image_count: number;
  known_cost: string;
};
type Report = {
  total_calls: number;
  unknown_calls: number;
  currencies: Record<string, string>;
  groups: Group[];
  calls: Call[];
  has_more: boolean;
  historical_count: number;
  historical: {
    id: string;
    created_at: string;
    total_tokens: number;
    unknown_reason: string;
  }[];
};
const purposes: Record<string, string> = {
  chat: "聊天",
  learning: "学习",
  complex_task: "复杂任务",
  context_compaction: "上下文压缩",
  image_reading: "图片理解",
  embedding: "Embedding",
  image_generation: "生图",
  connection_test: "连接测试",
};
const states: Record<string, string> = {
  started: "请求中",
  completed: "已返回",
  failed: "失败",
  interrupted: "中断",
};
function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dateBefore(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDate(date);
}
function amount(value: string) {
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 8 });
}
export function UsageCosts() {
  const [start, setStart] = useState(dateBefore(29));
  const [end, setEnd] = useState(dateBefore(0));
  const [range, setRange] = useState("30");
  const [view, setView] = useState("summary");
  const [offset, setOffset] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [selection, setSelection] = useState("");
  const [kind, setKind] = useState("tokens");
  const [currency, setCurrency] = useState("CNY");
  const [imageSize, setImageSize] = useState("");
  const [rates, setRates] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [priceError, setPriceError] = useState("");
  const priceForm = useRef<HTMLFormElement>(null);
  const records = useRef<HTMLDivElement>(null);
  const recordScroll = useRef<{
    element: HTMLElement;
    top: number;
    left: number;
  } | null>(null);
  const rateFields =
    kind === "images"
      ? [{ key: "image", label: "图片单价", required: true }]
      : [
          { key: "input", label: "输入单价", required: true },
          ...(kind === "tokens"
            ? [{ key: "output", label: "输出单价", required: true }]
            : []),
          { key: "cached", label: "缓存读取", required: false },
          { key: "cache_write", label: "缓存写入", required: false },
        ];
  function changeView(next: string) {
    if (next === view) return;
    const element = records.current?.closest<HTMLElement>(".page-body");
    if (element)
      recordScroll.current = {
        element,
        top: element.scrollTop,
        left: element.scrollLeft,
      };
    setView(next);
  }
  useLayoutEffect(() => {
    const saved = recordScroll.current;
    if (saved) {
      saved.element.scrollTop = saved.top;
      saved.element.scrollLeft = saved.left;
      recordScroll.current = null;
    }
  }, [view]);
  function clearPriceError(key: string) {
    setPriceErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setPriceError("");
    setNotice("");
  }
  const selected = models[Number(selection)];
  useEffect(() => {
    let live = true;
    Promise.all([api<Model[]>("/usage/models"), api<Price[]>("/usage/prices")])
      .then(([modelRows, priceRows]) => {
        if (live) {
          setModels(modelRows);
          setPrices(priceRows);
        }
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [revision]);
  useEffect(() => {
    let live = true;
    if (!start || !end || start > end) {
      setError("结束日期不能早于开始日期。");
      setReport(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError("");
    setReport(null);
    api<Report>(
      `/usage?start_date=${start}&end_date=${end}&offset=${offset}&limit=100`,
    )
      .then((value) => {
        if (live) setReport(value);
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [start, end, offset, revision]);
  function choose(value: string) {
    setSelection(value);
    setNotice("");
    setPriceErrors({});
    setPriceError("");
    const model = models[Number(value)];
    if (!model || !value) {
      setRates({});
      return;
    }
    const saved = prices.find(
      (p) =>
        p.provider_id === model.provider_id &&
        p.model_name === model.model_name,
    );
    setKind(saved?.kind || model.kind);
    setCurrency(saved?.currency || "CNY");
    setImageSize(saved?.image_size || "");
    setRates(saved?.rates || {});
  }
  async function savePrice() {
    if (!selected || !selection || saving) return;
    const issues: Record<string, string> = {};
    if (!/^[A-Z]{3}$/.test(currency.trim()))
      issues.currency = "请填写三位币种代码，例如 CNY 或 USD。";
    for (const field of rateFields) {
      const value = (rates[field.key] || "").trim();
      if (!value) {
        if (field.required)
          issues[field.key] = `请填写${field.label}；免费请填 0。`;
      } else if (
        !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ||
        !Number.isFinite(Number(value)) ||
        Number(value) > 1_000_000_000
      )
        issues[field.key] = "请输入 0 至 10 亿之间的有效单价。";
    }
    setPriceErrors(issues);
    setPriceError("");
    setNotice("");
    if (Object.keys(issues).length) {
      requestAnimationFrame(() =>
        priceForm.current
          ?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    setSaving(true);
    try {
      const configured = Object.fromEntries(
        Object.entries(rates)
          .filter(([, value]) => value.trim() !== "")
          .map(([key, value]) => [key, value.trim()]),
      );
      const allowed =
        kind === "images"
          ? ["image"]
          : kind === "embedding"
            ? ["input", "cached", "cache_write"]
            : ["input", "output", "cached", "cache_write"];
      const saved = await api<Price>("/usage/prices", "POST", {
        ...selected,
        kind,
        currency: currency.trim(),
        image_size: imageSize.trim(),
        rates: Object.fromEntries(
          Object.entries(configured).filter(([key]) => allowed.includes(key)),
        ),
      });
      setNotice("价格已保存，从后续调用生效；历史调用的价格与费用保持原记录。");
      setPrices((current) => [
        saved,
        ...current.filter((price) => price.id !== saved.id),
      ]);
    } catch (cause) {
      setPriceError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="usage-costs">
      <header className="usage-heading">
        <span className="usage-eyebrow">模型用量</span>
        <h2>用量与估算费用</h2>
        <p className="muted">
          统计 XiaoXi
          可观测的模型调用。估算费用不等于平台实际扣款，第三方工具内部消费不包含在内。
        </p>
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
              setOffset(0);
              if (value !== "custom") {
                setStart(dateBefore(Number(value) - 1));
                setEnd(dateBefore(0));
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
              setOffset(0);
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
              setOffset(0);
            }}
          />
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          刷新
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">正在读取用量…</p>}
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
            <div className="usage-stat usage-stat-cost">
              <span>已知估算费用</span>
              {Object.entries(report.currencies).length ? (
                Object.entries(report.currencies).map(([code, cost]) => (
                  <strong key={code}>
                    <small>{code}</small>
                    {amount(cost)}
                  </strong>
                ))
              ) : (
                <strong>—</strong>
              )}
              <p>
                {report.unknown_calls
                  ? "仅统计价格与用量齐全的调用"
                  : "各币种分别统计"}
              </p>
            </div>
            <div className="usage-stat">
              <span>费用待确定</span>
              <strong>
                {report.unknown_calls.toLocaleString("zh-CN")}
                <small>次</small>
              </strong>
              <p>
                {report.unknown_calls
                  ? "缺少单价或服务商未返回完整用量"
                  : "当前记录的费用均可估算"}
              </p>
            </div>
          </div>
          {report.unknown_calls > 0 && (
            <div className="usage-unknown-note">
              <span>
                未知费用未计入总额。可补充模型单价，或在调用明细中查看原因。
              </span>
              <a href="#usage-pricing">配置模型单价</a>
            </div>
          )}
          <div className="usage-records" ref={records}>
            <div className="usage-records-heading">
              <h3>用量记录</h3>
              <span>按连接、模型与时间查看</span>
            </div>
            <div
              className="usage-record-tabs"
              role="tablist"
              aria-label="用量记录视图"
            >
              {[
                { value: "summary", label: "模型汇总", count: null },
                {
                  value: "calls",
                  label: "调用明细",
                  count: report.total_calls,
                },
                {
                  value: "history",
                  label: "历史记录",
                  count: report.historical_count,
                },
              ].map((item, index, items) => (
                <button
                  type="button"
                  role="tab"
                  key={item.value}
                  id={`usage-tab-${item.value}`}
                  aria-selected={view === item.value}
                  aria-controls={`usage-panel-${item.value}`}
                  tabIndex={view === item.value ? 0 : -1}
                  onMouseDown={(event) => {
                    if (event.button === 0) {
                      event.preventDefault();
                      event.currentTarget.focus({ preventScroll: true });
                    }
                  }}
                  onClick={() => changeView(item.value)}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : (index +
                              (event.key === "ArrowRight"
                                ? 1
                                : items.length - 1)) %
                            items.length;
                    changeView(items[next].value);
                    document
                      .getElementById(`usage-tab-${items[next].value}`)
                      ?.focus({ preventScroll: true });
                  }}
                >
                  {item.label}
                  {item.count !== null && <span>{item.count}</span>}
                </button>
              ))}
            </div>
            <div className="usage-record-body">
              <div
                className="usage-record-panel"
                role="tabpanel"
                id="usage-panel-summary"
                aria-labelledby="usage-tab-summary"
                hidden={view !== "summary"}
              >
                <section className="usage-section">
                  <header>
                    <h3>模型用量汇总</h3>
                    <p>按连接、模型与用途分组</p>
                  </header>
                  <div className="usage-table-scroll">
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
                            "已知估算费用",
                            "未知",
                          ].map((name) => (
                            <th scope="col" key={name}>
                              {name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.groups.map((row, index) => (
                          <tr
                            key={`${row.provider_id}-${row.model_name}-${row.purpose}-${index}`}
                          >
                            <td className="usage-model">
                              <strong>{row.provider_label}</strong>
                              <small>{row.model_name}</small>
                            </td>
                            <td>{purposes[row.purpose] || row.purpose}</td>
                            <td>{row.calls}</td>
                            <td>
                              {row.input_tokens.toLocaleString()}
                              {row.unknown_input_calls > 0 && (
                                <small>
                                  {" "}
                                  + {row.unknown_input_calls} 次未知
                                </small>
                              )}
                            </td>
                            <td>
                              {row.output_tokens.toLocaleString()}
                              {row.unknown_output_calls > 0 && (
                                <small>
                                  {" "}
                                  + {row.unknown_output_calls} 次未知
                                </small>
                              )}
                            </td>
                            <td>
                              {row.cached_tokens.toLocaleString()}
                              {row.unknown_cached_calls > 0 && (
                                <small>
                                  （{row.unknown_cached_calls} 次未知）
                                </small>
                              )}{" "}
                              / {row.cache_write_tokens.toLocaleString()}
                              {row.unknown_cache_write_calls > 0 && (
                                <small>
                                  （{row.unknown_cache_write_calls} 次未知）
                                </small>
                              )}
                            </td>
                            <td>
                              {row.kind === "images" ? (
                                <>
                                  {row.image_count}
                                  {row.unknown_image_calls > 0 && (
                                    <small>
                                      {" "}
                                      + {row.unknown_image_calls} 次未知
                                    </small>
                                  )}
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>
                              {row.currency && row.known_calls > 0
                                ? `${row.currency} ${amount(row.known_cost)}`
                                : "未知"}
                            </td>
                            <td>
                              <span
                                className={
                                  row.unknown_calls
                                    ? "usage-unknown-badge"
                                    : "muted"
                                }
                              >
                                {row.unknown_calls}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!report.groups.length && (
                    <p className="muted">所选日期暂无逐次调用记录。</p>
                  )}
                </section>
              </div>
              <div
                className="usage-record-panel"
                role="tabpanel"
                id="usage-panel-calls"
                aria-labelledby="usage-tab-calls"
                hidden={view !== "calls"}
              >
                <section className="usage-section">
                  <header>
                    <h3>调用明细</h3>
                    <p>逐次查看模型用量、请求状态与费用依据</p>
                  </header>
                  <div className="usage-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          {[
                            "时间",
                            "连接 / 模型",
                            "用途 / 状态",
                            "输入 / 输出 Token",
                            "缓存读 / 写",
                            "图片",
                            "估算费用",
                          ].map((name) => (
                            <th scope="col" key={name}>
                              {name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.calls.map((row) => (
                          <tr key={row.id}>
                            <td>
                              {new Date(row.created_at).toLocaleString("zh-CN")}
                            </td>
                            <td className="usage-model">
                              <strong>{row.provider_label}</strong>
                              <small>{row.model_name}</small>
                            </td>
                            <td>
                              {purposes[row.purpose] || row.purpose}
                              <br />
                              {states[row.status] || row.status}
                            </td>
                            <td>
                              {row.input_tokens ?? "未知"} /{" "}
                              {row.output_tokens ?? "未知"}
                            </td>
                            <td>
                              {row.cached_tokens ?? "—"} /{" "}
                              {row.cache_write_tokens ?? "—"}
                            </td>
                            <td>{row.image_count ?? "—"}</td>
                            <td>
                              {row.estimated_cost !== null ? (
                                `${row.price_snapshot.currency} ${amount(row.estimated_cost)}`
                              ) : (
                                <span title={row.unknown_reason}>
                                  未知
                                  <br />
                                  <small>{row.unknown_reason}</small>
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                    <Button
                      variant="outline"
                      disabled={!offset || busy}
                      onClick={() => setOffset(Math.max(0, offset - 100))}
                    >
                      上一页
                    </Button>
                    <span>第 {Math.floor(offset / 100) + 1} 页</span>
                    <Button
                      variant="outline"
                      disabled={!report.has_more || busy}
                      onClick={() => setOffset(offset + 100)}
                    >
                      下一页
                    </Button>
                  </div>
                </section>
              </div>
              <div
                className="usage-record-panel"
                role="tabpanel"
                id="usage-panel-history"
                aria-labelledby="usage-tab-history"
                hidden={view !== "history"}
              >
                <section className="usage-section">
                  <header>
                    <h3>历史不完整用量</h3>
                    <p>
                      旧记录仅保留总 Token，以下展示最近{" "}
                      {report.historical.length}{" "}
                      条，不推算模型、输入输出或费用。
                    </p>
                  </header>
                  <div className="usage-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">时间</th>
                          <th scope="col">总 Token</th>
                          <th scope="col">费用状态</th>
                          <th scope="col">原因</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.historical.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <time dateTime={row.created_at}>
                                {new Date(row.created_at).toLocaleString(
                                  "zh-CN",
                                )}
                              </time>
                            </td>
                            <td>{row.total_tokens.toLocaleString("zh-CN")}</td>
                            <td>
                              <span className="usage-unknown-badge">未知</span>
                            </td>
                            <td>
                              {row.unknown_reason || "旧记录缺少模型与详细用量"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!report.historical.length && (
                    <p className="history-empty">
                      所选日期内没有不完整的历史用量记录。
                    </p>
                  )}
                </section>
              </div>
            </div>
          </div>
        </>
      )}
      <section className="usage-section usage-pricing" id="usage-pricing">
        <header>
          <h3>配置模型单价</h3>
          <p>单价保存后，从下一次调用开始生效</p>
        </header>
        <p className="muted">
          请填写服务商对应的价格。空白表示未配置，零表示你明确配置免费。缓存单价留空时按普通输入价估算；填写后若服务商未返回缓存用量，则费用显示未知。不同币种分别汇总。
        </p>
        <form
          ref={priceForm}
          noValidate
          className="usage-price-form"
          onSubmit={(event) => {
            event.preventDefault();
            void savePrice();
          }}
        >
          <div className="usage-model-field">
            <label htmlFor="usage-model">连接与模型</label>
            <SoftSelect
              id="usage-model"
              disabled={saving}
              label="连接与模型"
              value={selection}
              onValueChange={choose}
              placeholder="选择模型"
              options={models.map((row, index) => ({
                value: String(index),
                label: `${row.provider_label} · ${row.model_name} · ${row.kind === "embedding" ? "Embedding" : row.kind === "images" ? "生图" : "文本"}`,
              }))}
            />
          </div>
          {selection && selected && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                <div className="usage-model-field">
                  <label htmlFor="usage-billing">计价方式</label>
                  <SoftSelect
                    id="usage-billing"
                    disabled={saving}
                    label="计价方式"
                    value={kind}
                    onValueChange={(value) => {
                      setKind(value);
                      setPriceErrors({});
                      setPriceError("");
                    }}
                    options={[
                      selected.kind === "embedding"
                        ? { value: "embedding", label: "每百万输入 Token" }
                        : { value: "tokens", label: "每百万 Token" },
                      ...(selected.kind === "images"
                        ? [{ value: "images", label: "每张图片" }]
                        : []),
                    ]}
                  />
                </div>
                <label htmlFor="usage-currency">
                  币种
                  <input
                    id="usage-currency"
                    disabled={saving}
                    type="text"
                    aria-invalid={Boolean(priceErrors.currency)}
                    aria-describedby={
                      priceErrors.currency ? "usage-currency-error" : undefined
                    }
                    value={currency}
                    maxLength={3}
                    onChange={(event) => {
                      setCurrency(event.target.value.toUpperCase());
                      clearPriceError("currency");
                    }}
                    placeholder="CNY"
                  />
                  {priceErrors.currency && (
                    <span
                      className="price-field-error"
                      id="usage-currency-error"
                    >
                      {priceErrors.currency}
                    </span>
                  )}
                </label>
                {selected.kind === "images" && (
                  <label>
                    图片尺寸
                    <input
                      value={imageSize}
                      disabled={saving}
                      maxLength={40}
                      onChange={(event) => setImageSize(event.target.value)}
                      placeholder="留空适用于全部尺寸"
                    />
                  </label>
                )}
              </div>
              <div className="usage-price-grid">
                {rateFields.map((field) => (
                  <div className="usage-rate-field" key={field.key}>
                    <label htmlFor={`usage-rate-${field.key}`}>
                      <span>{field.label}</span>
                      <small>{field.required ? "必填" : "可选"}</small>
                    </label>
                    <div
                      className={`usage-price-input ${priceErrors[field.key] ? "is-invalid" : ""}`}
                    >
                      <span>{currency || "CNY"}</span>
                      <input
                        id={`usage-rate-${field.key}`}
                        type="text"
                        inputMode="decimal"
                        maxLength={40}
                        value={rates[field.key] || ""}
                        placeholder={field.required ? "0.00" : "沿用输入单价"}
                        disabled={saving}
                        aria-invalid={Boolean(priceErrors[field.key])}
                        aria-describedby={`usage-rate-${field.key}-help`}
                        onChange={(event) => {
                          setRates((value) => ({
                            ...value,
                            [field.key]: event.target.value,
                          }));
                          clearPriceError(field.key);
                        }}
                      />
                    </div>
                    <p
                      id={`usage-rate-${field.key}-help`}
                      className={
                        priceErrors[field.key]
                          ? "price-field-error"
                          : "usage-price-unit"
                      }
                    >
                      {priceErrors[field.key] ||
                        (kind === "images" ? "每张图片" : "每百万 Token")}
                    </p>
                  </div>
                ))}
              </div>
              {Object.keys(priceErrors).length > 0 && (
                <p className="price-error-summary" role="alert">
                  请修正标出的项目后再保存。
                </p>
              )}
              {priceError && (
                <p className="price-error-summary" role="alert">
                  {priceError}
                </p>
              )}
              {notice && (
                <p className="price-save-notice" role="status">
                  {notice}
                </p>
              )}
              <div>
                <Button type="submit" disabled={saving}>
                  {saving ? "正在保存…" : "保存价格"}
                </Button>
              </div>
            </>
          )}
        </form>
        <div className="usage-price-versions">
          <DetailDialog
            title="已保存的价格版本"
            label={`价格版本 · ${prices.length}`}
            description="每次调用使用当时生效的价格快照，修改价格仅影响后续调用。"
          >
            <div className="usage-table-scroll usage-costs">
              <table>
                <thead>
                  <tr>
                    <th scope="col">生效时间</th>
                    <th scope="col">连接 / 模型</th>
                    <th scope="col">计价单位</th>
                    <th scope="col">币种</th>
                    <th scope="col">输入 / 图片</th>
                    <th scope="col">输出</th>
                    <th scope="col">缓存读 / 写</th>
                    <th scope="col">图片尺寸</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((price) => (
                    <tr key={price.id}>
                      <td>
                        {new Date(price.created_at).toLocaleString("zh-CN")}
                      </td>
                      <td className="usage-model">
                        <strong>{price.provider_label}</strong>
                        <small>{price.model_name}</small>
                      </td>
                      <td>
                        {price.kind === "images" ? "每张图片" : "每百万 Token"}
                      </td>
                      <td>{price.currency}</td>
                      <td>
                        {price.kind === "images"
                          ? price.rates.image
                          : (price.rates.input ?? "—")}
                      </td>
                      <td>{price.rates.output ?? "—"}</td>
                      <td>
                        {price.rates.cached ?? "—"} /{" "}
                        {price.rates.cache_write ?? "—"}
                      </td>
                      <td>{price.image_size || "全部尺寸"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!prices.length && (
              <p className="history-empty">
                尚未配置模型单价。选择模型后填写单价即可创建首个版本。
              </p>
            )}
          </DetailDialog>
        </div>
      </section>
    </div>
  );
}
