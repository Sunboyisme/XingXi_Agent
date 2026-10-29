import { useId, useState, type Ref } from "react";
import { Input } from "./ui/input";

const contextCapacities = [
  8000, 32000, 64000, 128000, 256000, 1000000, 2000000,
];

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
  const helpId = useId();
  const [entry, setEntry] = useState({
    tokens: value,
    amount: String(value / 1000),
  });
  const amount = entry.tokens === value ? entry.amount : String(value / 1000);
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
          aria-describedby={valid ? undefined : helpId}
          value={amount}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            if (!/^\d*(?:\.\d{0,3})?$/.test(next)) return;
            const tokens = Math.round((Number(next) || 0) * 1000);
            setEntry({ tokens, amount: next });
            onChange(tokens);
          }}
        />
        <span className="context-capacity-unit">k token</span>
      </div>
      <div
        className="context-capacity-presets"
        role="group"
        aria-label="快捷上下文容量"
      >
        {contextCapacities.map((tokens) => (
          <button
            key={tokens}
            type="button"
            disabled={disabled}
            aria-pressed={value === tokens}
            onClick={() => {
              setEntry({ tokens, amount: String(tokens / 1000) });
              onChange(tokens);
            }}
          >
            {tokens >= 1000000 ? `${tokens / 1000000}M` : `${tokens / 1000}k`}
          </button>
        ))}
      </div>
      {!valid && (
        <small id={helpId} className="context-capacity-error" role="alert">
          请输入 4.096–2,000k token，或选择上方容量。
        </small>
      )}
    </div>
  );
}
