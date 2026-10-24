import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
import "@/styles/usage-costs.css";

type Model = { provider_id: string; provider_label: string; model_name: string; kind: string };
type Price = Model & { id: string; created_at: string; currency: string; image_size: string; rates: Record<string, string> };
type Call = Model & {
  id: string; created_at: string; purpose: string; status: string;
  input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  cached_tokens: number | null; cache_write_tokens: number | null; image_count: number | null;
  estimated_cost: string | null; unknown_reason: string;
  price_snapshot: { currency?: string };
};
type Group = Model & { purpose: string; currency: string | null; calls: number; unknown_calls: number; known_calls: number;
  unknown_input_calls: number; unknown_output_calls: number; unknown_image_calls: number;
  unknown_cached_calls: number; unknown_cache_write_calls: number;
  input_tokens: number; output_tokens: number; cached_tokens: number; cache_write_tokens: number;
  image_count: number; known_cost: string };
type Report = { total_calls: number; unknown_calls: number; currencies: Record<string, string>;
  groups: Group[]; calls: Call[]; has_more: boolean; historical_count: number;
  historical: { id: string; created_at: string; total_tokens: number; unknown_reason: string }[] };
const purposes: Record<string, string> = { chat: "聊天", learning: "学习", complex_task: "复杂任务",
  context_compaction: "上下文压缩", image_reading: "图片理解", embedding: "Embedding",
  image_generation: "生图", connection_test: "连接测试" };
const states: Record<string, string> = { started: "请求中", completed: "已返回", failed: "失败", interrupted: "中断" };
function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dateBefore(days: number) { const date = new Date(); date.setDate(date.getDate() - days); return localDate(date); }
function amount(value: string) { return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 8 }); }
const cell = { padding: "10px 12px", textAlign: "left" as const, whiteSpace: "nowrap" as const,
  borderBottom: "1px solid var(--ui-color-line)" };

export function UsageCosts() {
  const [start, setStart] = useState(dateBefore(29));
  const [end, setEnd] = useState(dateBefore(0));
  const [range, setRange] = useState("30");
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
  const selected = models[Number(selection)];
  useEffect(() => {
    let live = true;
    Promise.all([api<Model[]>("/usage/models"), api<Price[]>("/usage/prices")])
      .then(([modelRows, priceRows]) => { if (live) { setModels(modelRows); setPrices(priceRows); } })
      .catch((cause: Error) => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [revision]);
  useEffect(() => {
    let live = true;
    setBusy(true); setError("");
    api<Report>(`/usage?start_date=${start}&end_date=${end}&offset=${offset}&limit=100`)
      .then((value) => { if (live) setReport(value); })
      .catch((cause: Error) => { if (live) setError(cause.message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [start, end, offset, revision]);
  function choose(value: string) {
    setSelection(value); setNotice("");
    const model = models[Number(value)];
    if (!model || !value) { setRates({}); return; }
    const saved = prices.find((p) => p.provider_id === model.provider_id && p.model_name === model.model_name);
    setKind(saved?.kind || model.kind); setCurrency(saved?.currency || "CNY");
    setImageSize(saved?.image_size || ""); setRates(saved?.rates || {});
  }
  async function savePrice() {
    if (!selected || !selection || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const configured = Object.fromEntries(Object.entries(rates).filter(([, value]) => value.trim() !== ""));
      const allowed = kind === "images" ? ["image"] : kind === "embedding" ? ["input", "cached", "cache_write"] : ["input", "output", "cached", "cache_write"];
      await api("/usage/prices", "POST", { ...selected, kind, currency, image_size: imageSize.trim(),
        rates: Object.fromEntries(Object.entries(configured).filter(([key]) => allowed.includes(key))) });
      setNotice("价格已保存，从后续调用生效；历史调用的价格与费用保持原记录。");
      setRevision((value) => value + 1);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }
  return <div className="usage-costs" style={{ display: "grid", gap: 24 }}>
    <div><h2>用量与估算费用</h2><p className="muted">统计 XiaoXi 可观测的模型调用。估算费用不等于平台实际扣款，第三方工具内部消费不包含在内。</p></div>
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
      <label>日期范围<select aria-label="费用日期范围" value={range} onChange={(event) => {
        const value = event.target.value; setRange(value); setOffset(0);
        if (value !== "custom") { setStart(dateBefore(Number(value) - 1)); setEnd(dateBefore(0)); }
      }}><option value="1">今日</option><option value="7">近七天</option><option value="30">近三十天</option><option value="custom">自定义</option></select></label>
      <label>开始日期<input type="date" value={start} onChange={(event) => { setStart(event.target.value); setRange("custom"); setOffset(0); }} /></label>
      <label>结束日期<input type="date" value={end} onChange={(event) => { setEnd(event.target.value); setRange("custom"); setOffset(0); }} /></label>
      <Button variant="outline" disabled={busy} onClick={() => setRevision((value) => value + 1)}>刷新</Button>
    </div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {busy && <p role="status">正在读取用量…</p>}
    {report && <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 22 }}>
        <div><strong>{report.total_calls}</strong> 次调用</div>
        {Object.entries(report.currencies).map(([code, cost]) => <div key={code}><strong>{code} {amount(cost)}</strong> 已知估算费用</div>)}
        <div><strong>{report.unknown_calls}</strong> 次费用未知</div>
      </div>
      <div><h3>按连接、模型与用途汇总</h3><div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["连接 / 模型", "用途", "调用", "输入 Token", "输出 Token", "缓存读 / 写", "图片", "已知估算费用", "未知"].map((name) => <th style={cell} key={name}>{name}</th>)}</tr></thead>
        <tbody>{report.groups.map((row, index) => <tr key={`${row.provider_id}-${row.model_name}-${row.purpose}-${index}`}>
          <td style={cell}>{row.provider_label}<br /><small>{row.model_name}</small></td><td style={cell}>{purposes[row.purpose] || row.purpose}</td>
          <td style={cell}>{row.calls}</td><td style={cell}>{row.input_tokens.toLocaleString()}{row.unknown_input_calls > 0 && <small> + {row.unknown_input_calls} 次未知</small>}</td><td style={cell}>{row.output_tokens.toLocaleString()}{row.unknown_output_calls > 0 && <small> + {row.unknown_output_calls} 次未知</small>}</td>
          <td style={cell}>{row.cached_tokens.toLocaleString()}{row.unknown_cached_calls > 0 && <small>（{row.unknown_cached_calls} 次未知）</small>} / {row.cache_write_tokens.toLocaleString()}{row.unknown_cache_write_calls > 0 && <small>（{row.unknown_cache_write_calls} 次未知）</small>}</td><td style={cell}>{row.kind === "images" ? <>{row.image_count}{row.unknown_image_calls > 0 && <small> + {row.unknown_image_calls} 次未知</small>}</> : "—"}</td>
          <td style={cell}>{row.currency && row.known_calls > 0 ? `${row.currency} ${amount(row.known_cost)}` : "未知"}</td><td style={cell}>{row.unknown_calls}</td>
        </tr>)}</tbody></table></div>{!report.groups.length && <p className="muted">所选日期暂无逐次调用记录。</p>}</div>
      <details><summary>调用明细（{report.total_calls}）</summary><div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["时间", "连接 / 模型", "用途 / 状态", "输入 / 输出 Token", "缓存读 / 写", "图片", "估算费用"].map((name) => <th key={name} style={cell}>{name}</th>)}</tr></thead>
        <tbody>{report.calls.map((row) => <tr key={row.id}><td style={cell}>{new Date(row.created_at).toLocaleString("zh-CN")}</td>
          <td style={cell}>{row.provider_label}<br /><small>{row.model_name}</small></td><td style={cell}>{purposes[row.purpose] || row.purpose}<br />{states[row.status] || row.status}</td>
          <td style={cell}>{row.input_tokens ?? "未知"} / {row.output_tokens ?? "未知"}</td><td style={cell}>{row.cached_tokens ?? "—"} / {row.cache_write_tokens ?? "—"}</td><td style={cell}>{row.image_count ?? "—"}</td>
          <td style={cell}>{row.estimated_cost !== null ? `${row.price_snapshot.currency} ${amount(row.estimated_cost)}` : <span title={row.unknown_reason}>未知<br /><small>{row.unknown_reason}</small></span>}</td></tr>)}</tbody></table></div>
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}><Button variant="outline" disabled={!offset || busy} onClick={() => setOffset(Math.max(0, offset - 100))}>上一页</Button>
          <span>第 {Math.floor(offset / 100) + 1} 页</span><Button variant="outline" disabled={!report.has_more || busy} onClick={() => setOffset(offset + 100)}>下一页</Button></div></details>
      {report.historical_count > 0 && <details><summary>历史不完整用量（{report.historical_count} 条）</summary>
        <p className="muted">旧运行仅保留总 Token，无法可靠还原模型、输入输出或费用。以下最多显示最近一百条。</p>
        {report.historical.map((row) => <p key={row.id}>{new Date(row.created_at).toLocaleString("zh-CN")} · {row.total_tokens.toLocaleString()} 总 Token · 费用未知</p>)}</details>}
    </>}
    <section style={{ borderTop: "1px solid var(--ui-color-line)", paddingTop: 20 }}>
      <h3>配置模型单价</h3><p className="muted">请填写服务商对应的价格。空白表示未配置，零表示你明确配置免费。缓存单价留空时按普通输入价估算；填写后若服务商未返回缓存用量，则费用显示未知。不同币种分别汇总。</p>
      <form onSubmit={(event) => { event.preventDefault(); void savePrice(); }} style={{ display: "grid", gap: 14, maxWidth: 720 }}>
        <label>连接与模型<select value={selection} onChange={(event) => choose(event.target.value)}><option value="">选择模型</option>{models.map((row, index) => <option value={String(index)} key={`${row.provider_id}-${row.model_name}-${row.kind}`}>{row.provider_label} · {row.model_name} · {row.kind === "embedding" ? "Embedding" : row.kind === "images" ? "生图" : "文本"}</option>)}</select></label>
        {selection && selected && <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <label>计价方式<select value={kind} onChange={(event) => setKind(event.target.value)}>
              {selected.kind === "embedding" ? <option value="embedding">每百万输入 Token</option> : <option value="tokens">每百万 Token</option>}
              {selected.kind === "images" && <option value="images">每张图片</option>}
            </select></label>
            <label>币种<input value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} placeholder="CNY" required /></label>
            {selected.kind === "images" && <label>图片尺寸<input value={imageSize} onChange={(event) => setImageSize(event.target.value)} placeholder="留空适用于全部尺寸" /></label>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {(kind === "images" ? [["image", "每张图片单价"]] : [["input", "输入单价 / 百万 Token"], ...(kind === "tokens" ? [["output", "输出单价 / 百万 Token"]] : []), ["cached", "缓存读取单价（可选）"], ["cache_write", "缓存写入单价（可选）"]]).map(([key, title]) => <label key={key}>{title}<input type="number" min="0" max="1000000000" step="any" value={rates[key] || ""}
              required={key === "input" || key === "output" || key === "image"} onChange={(event) => setRates((value) => ({ ...value, [key]: event.target.value }))} /></label>)}
          </div>
          <div><Button type="submit" disabled={saving}>{saving ? "正在保存…" : "保存价格"}</Button></div>
        </>}
      </form>
      <details style={{ marginTop: 18 }}><summary>已保存的价格版本（{prices.length}）</summary>{prices.map((price) => <p key={price.id}>{price.provider_label} · {price.model_name} · {price.currency} · {price.kind === "images" ? `每张 ${price.rates.image}` : `输入 ${price.rates.input} / 输出 ${price.rates.output ?? "0"}（每百万 Token）`}{price.image_size && ` · ${price.image_size}`} · {new Date(price.created_at).toLocaleString("zh-CN")} 起生效</p>)}</details>
    </section>
  </div>;
}
