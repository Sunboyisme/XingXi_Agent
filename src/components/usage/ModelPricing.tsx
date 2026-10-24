import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import {
  type UsageModel,
  type UsagePrice,
  usageModelKey,
} from "@/lib/usageCosts";
import { Button } from "../ui/button";
import { SoftSelect } from "../ui/soft-select";
import { DetailDialog } from "../ui/detail-dialog";

export function ModelPricing({ onBack }: { onBack: () => void }) {
  const [models, setModels] = useState<UsageModel[]>([]);
  const [prices, setPrices] = useState<UsagePrice[]>([]);
  const [selection, setSelection] = useState("");
  const [kind, setKind] = useState("tokens");
  const [currency, setCurrency] = useState("CNY");
  const [imageSize, setImageSize] = useState("");
  const [rates, setRates] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [priceError, setPriceError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const priceForm = useRef<HTMLFormElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backButton.current?.focus({ preventScroll: true });
  }, []);
  const selected = models.find((model) => usageModelKey(model) === selection);
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
  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError("");
    Promise.all([
      api<UsageModel[]>("/usage/models"),
      api<UsagePrice[]>("/usage/prices"),
    ])
      .then(([modelRows, priceRows]) => {
        if (live) {
          setModels(modelRows);
          setPrices(priceRows);
        }
      })
      .catch((cause: Error) => {
        if (live) setLoadError(cause.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [revision]);
  function clearPriceError(key: string) {
    setPriceErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setPriceError("");
    setNotice("");
  }
  function choose(value: string) {
    setSelection(value);
    setNotice("");
    setPriceErrors({});
    setPriceError("");
    const model = models.find((item) => usageModelKey(item) === value);
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
      const saved = await api<UsagePrice>("/usage/prices", "POST", {
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
    <div className="usage-pricing-page">
      <Button
        className="usage-pricing-back"
        ref={backButton}
        variant="ghost"
        disabled={saving}
        onClick={onBack}
      >
        <ArrowLeft size={15} />
        返回费用
      </Button>
      {loadError && (
        <div className="usage-load-error" role="alert">
          <p>{loadError}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRevision((value) => value + 1)}
          >
            重新读取
          </Button>
        </div>
      )}
      {loading && <p role="status">正在读取模型与价格…</p>}
      <section
        className="usage-section usage-pricing"
        aria-label="模型单价配置"
      >
        <header>
          <h2>模型单价</h2>
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
              options={models.map((row) => ({
                value: usageModelKey(row),
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
              {kind !== "images" && <p className="usage-cache-help">缓存读取指命中服务商缓存的输入用量，缓存写入指建立缓存的输入用量。是否单列由服务商决定；不清楚可留空，估算时沿用输入单价。</p>}
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
