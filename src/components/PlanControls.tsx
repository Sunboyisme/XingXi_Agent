import { Check, RotateCcw } from "lucide-react";
import { Hint } from "./common";

type PlanView = "todo" | "month" | "week";

const views: { value: PlanView; label: string }[] = [
  { value: "todo", label: "待办" },
  { value: "month", label: "月历" },
  { value: "week", label: "周历" },
];

export function PlanViewSwitch({
  value,
  onChange,
}: {
  value: PlanView;
  onChange: (view: PlanView) => void;
}) {
  return (
    <div className="calendar-view-switch" role="group" aria-label="计划视图">
      {views.map((view) => (
        <button
          key={view.value}
          type="button"
          aria-pressed={value === view.value}
          onClick={() => onChange(view.value)}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}

export function PlanCompletionButton({
  status,
  label,
  disabled,
  onClick,
}: {
  status: string;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Hint
      label={
        ["completed", "cancelled"].includes(status)
          ? "恢复为未完成"
          : "标记为已完成"
      }
    >
      <button
        type="button"
        className="complete-circle"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {status === "completed" && <Check size={13} />}
        {status === "cancelled" && <RotateCcw size={13} />}
      </button>
    </Hint>
  );
}
