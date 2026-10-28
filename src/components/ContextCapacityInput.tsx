import { useEffect, useId, useState, type Ref } from "react";
import { Input } from "./ui/input";
import { SoftSelect } from "./ui/soft-select";

const capacities = [
  8000, 32000, 64000, 128000, 256000, 500000, 1000000, 2000000,
];
const initialUnit = (value: number) => (value >= 10000 ? 10000 : 1);

export function ContextCapacityInput({
  value = 500000,
  disabled,
  label,
  inputRef,
  onChange,
}: {
  value?: number;
  disabled?: boolean;
  label: string;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (tokens: number) => void;
}) {
  const [unit, setUnit] = useState(() => initialUnit(value));
  const helpId = useId();
  const [amount, setAmount] = useState(() =>
    String(value / initialUnit(value)),
  );
  useEffect(() => {
    if (Number(amount) * unit !== value) setAmount(String(value / unit));
  }, [value, unit, amount]);
  const valid = Number.isInteger(value) && value >= 4096 && value <= 2000000;
  return (
    <div className="context-capacity-control">
      <div className="context-capacity-entry">
        <Input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          aria-label={label}
          aria-invalid={!valid}
          aria-describedby={helpId}
          value={amount}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            if (!/^\d*(?:\.\d*)?$/.test(next)) return;
            setAmount(next);
            onChange(Number(next || 0) * unit);
          }}
        />
        <SoftSelect
          label={`${label}单位`}
          value={String(unit)}
          disabled={disabled}
          options={[
            { value: "1", label: "token" },
            { value: "1000", label: "千 token" },
            { value: "10000", label: "万 token" },
          ]}
          onValueChange={(next) => {
            setUnit(Number(next));
            setAmount(String(value / Number(next)));
          }}
        />
      </div>
      <div className="context-capacity-presets" aria-label="快捷上下文容量">
        {capacities.map((tokens) => (
          <button
            key={tokens}
            type="button"
            disabled={disabled}
            aria-pressed={value === tokens}
            onClick={() => {
              const nextUnit = tokens >= 10000 ? 10000 : 1000;
              setUnit(nextUnit);
              setAmount(String(tokens / nextUnit));
              onChange(tokens);
            }}
          >
            {tokens < 10000 ? `${tokens / 1000}千` : `${tokens / 10000}万`}
          </button>
        ))}
      </div>
      <small
        id={helpId}
        className={valid ? "context-capacity-help" : "context-capacity-error"}
        role={valid ? undefined : "alert"}
      >
        {valid
          ? "同时参考的聊天与资料量，请按服务商上限填写。"
          : "容量需至少约4千、最多200万 token，可直接选择上方容量。"}
      </small>
    </div>
  );
}
