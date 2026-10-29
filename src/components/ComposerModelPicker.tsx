import { useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Settings2,
  Sparkles,
} from "lucide-react";
import { Popover, RadioGroup } from "radix-ui";
import type { Settings } from "@/lib/api";
import type { ModelOptions } from "@/lib/chatModelPreferences";
import { effortLabel } from "@/lib/reasoningEffort";
import { Hint } from "./common";
import { ContextCapacityInput } from "./ContextCapacityInput";
import { ContextMeter, type ContextUsage } from "./ContextMeter";
import { Button } from "./ui/button";

type ModelChoice = {
  key: string;
  model: Settings["providers"][number]["models"][number];
  profile: Settings["providers"][number];
};

export function ComposerModelPicker({
  choices,
  selected,
  options,
  thinkingEnabled,
  contextTokens,
  usage,
  compacting,
  disabled,
  defaultProvider,
  onSelect,
  onOptions,
  onSettings,
}: {
  choices: ModelChoice[];
  selected?: ModelChoice;
  options: ModelOptions;
  thinkingEnabled: boolean;
  contextTokens: number;
  usage: ContextUsage | null;
  compacting: boolean;
  disabled: boolean;
  defaultProvider: string;
  onSelect: (key: string) => void;
  onOptions: (patch: Partial<ModelOptions>) => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"thinking" | "context" | null>(null);
  const [capacity, setCapacity] = useState(contextTokens);
  const contextInput = useRef<HTMLInputElement>(null);
  const control = selected?.model.thinking_control || "none";
  const levels = selected?.model.reasoning_efforts || [];
  const activeEffort = levels.includes(
    options.reasoningEffort as (typeof levels)[number],
  )
    ? options.reasoningEffort
    : selected?.model.default_reasoning_effort;
  const thinkingValue = !thinkingEnabled
    ? "off"
    : levels.length
      ? levels.includes(options.reasoningEffort as (typeof levels)[number])
        ? options.reasoningEffort
        : "auto"
      : "on";
  const thinkingLabel =
    control === "none"
      ? "不支持"
      : !thinkingEnabled
        ? "关闭"
        : levels.length
          ? effortLabel(activeEffort)
          : control === "always"
            ? "始终开启"
            : "开启";
  const validCapacity =
    Number.isInteger(capacity) && capacity >= 4096 && capacity <= 2000000;

  function showContext() {
    setCapacity(contextTokens);
    setPanel("context");
    setOpen(true);
  }

  return (
    <div className="composer-model-controls">
      <ContextMeter
        usage={usage}
        limit={contextTokens}
        compacting={compacting}
        disabled={disabled || !selected}
        onSettings={showContext}
      />
      <Popover.Root
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setPanel(null);
        }}
      >
        <Hint
          label={
            selected ? (
              <>
                <span>{selected.model.name}</span>
                <span>{selected.profile.label}</span>
              </>
            ) : (
              "选择模型"
            )
          }
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              className="composer-model"
              aria-label="选择模型"
              disabled={disabled}
            >
              {thinkingEnabled && <Sparkles size={13} aria-hidden="true" />}
              <span>{selected?.model.name || "选择模型"}</span>
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          </Popover.Trigger>
        </Hint>
        <Popover.Portal>
          <Popover.Content
            className="composer-model-menu"
            side="top"
            align="end"
            sideOffset={10}
            collisionPadding={12}
            aria-label="模型与当前对话设置"
            onOpenAutoFocus={(event) => {
              if (panel === "context" && contextInput.current) {
                event.preventDefault();
                contextInput.current.focus();
              }
            }}
          >
            <div className="composer-model-menu-heading">选择模型</div>
            <RadioGroup.Root
              className="composer-model-choices"
              aria-label="可用模型"
              value={selected?.key || ""}
              disabled={disabled}
              onValueChange={(key) => {
                onSelect(key);
                setPanel(null);
              }}
            >
              {choices
                .filter((choice) => choice.profile.key_configured)
                .map((choice) => (
                  <Hint
                    key={choice.key}
                    label={
                      <>
                        <span>{choice.model.name}</span>
                        <span>{choice.profile.label}</span>
                      </>
                    }
                  >
                    <RadioGroup.Item
                      value={choice.key}
                      className="composer-model-choice"
                    >
                      <span>
                        <strong>{choice.model.name}</strong>
                        <small>
                          {choice.profile.label}
                          {choice.profile.id === defaultProvider &&
                          choice.model.name === choice.profile.default_model
                            ? " · 默认"
                            : ""}
                        </small>
                      </span>
                      <RadioGroup.Indicator>
                        <Check size={15} />
                      </RadioGroup.Indicator>
                    </RadioGroup.Item>
                  </Hint>
                ))}
              {!choices.some((choice) => choice.profile.key_configured) && (
                <p className="model-menu-current">尚未连接模型</p>
              )}
            </RadioGroup.Root>
            {selected && (
              <div className="composer-model-options">
                <p>仅对当前对话生效</p>
                <button
                  type="button"
                  className="composer-model-option"
                  disabled={
                    disabled ||
                    control === "none" ||
                    (control === "always" && !levels.length)
                  }
                  aria-expanded={panel === "thinking"}
                  onClick={() =>
                    setPanel(panel === "thinking" ? null : "thinking")
                  }
                >
                  <span>思考{levels.length ? "强度" : "模式"}</span>
                  <span>
                    {thinkingLabel}
                    <ChevronRight size={13} />
                  </span>
                </button>
                {panel === "thinking" && (
                  <RadioGroup.Root
                    className="composer-effort-options"
                    aria-label="思考设置"
                    value={thinkingValue}
                    disabled={disabled}
                    onValueChange={(value) =>
                      onOptions({
                        thinking: value !== "off",
                        reasoningEffort:
                          value === "off" || value === "on" || value === "auto"
                            ? undefined
                            : value,
                      })
                    }
                  >
                    {control !== "always" && (
                      <RadioGroup.Item value="off">关闭</RadioGroup.Item>
                    )}
                    {levels.length ? (
                      <>
                        <RadioGroup.Item value="auto">
                          服务商默认
                        </RadioGroup.Item>
                        {levels.map((level) => (
                          <RadioGroup.Item key={level} value={level}>
                            {effortLabel(level)}
                          </RadioGroup.Item>
                        ))}
                      </>
                    ) : (
                      <RadioGroup.Item value="on">开启</RadioGroup.Item>
                    )}
                  </RadioGroup.Root>
                )}
                <button
                  type="button"
                  className="composer-model-option"
                  disabled={disabled}
                  aria-expanded={panel === "context"}
                  onClick={() => {
                    if (panel === "context") setPanel(null);
                    else showContext();
                  }}
                >
                  <span>上下文窗口</span>
                  <span>
                    {contextTokens / 1000}k<ChevronRight size={13} />
                  </span>
                </button>
                {panel === "context" && (
                  <div className="composer-context-panel">
                    <ContextCapacityInput
                      label="当前对话上下文容量"
                      value={capacity}
                      disabled={disabled}
                      inputRef={contextInput}
                      onChange={setCapacity}
                    />
                    <p>
                      包含历史、工具结果与回复预留。设置容量不会扩展模型本身的能力。
                    </p>
                    <div className="composer-context-actions">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => {
                          onOptions({ contextTokens: undefined });
                          setPanel(null);
                        }}
                      >
                        恢复模型默认
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={disabled || !validCapacity}
                        onClick={() => {
                          onOptions({ contextTokens: capacity });
                          setPanel(null);
                        }}
                      >
                        应用
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              className="composer-model-settings"
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              <Settings2 size={15} />
              连接与设置
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
