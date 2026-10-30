import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Settings2 } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { Settings } from "@/lib/api";
import type { ModelOptions } from "@/lib/chatModelPreferences";
import { effortLabel, effortOptions } from "@/lib/reasoningEffort";

type ModelChoice = {
  key: string;
  model: Settings["providers"][number]["models"][number];
  profile: Settings["providers"][number];
};

const contextPresets = [300000, 600000, 1000000];
const capacityLabel = (tokens: number) =>
  tokens >= 1000000 ? `${tokens / 1000000}M` : `${tokens / 1000}K`;
const keepMenuOpen = (event: Event) => event.preventDefault();

export function ComposerModelPicker({
  contextMeter,
  choices,
  selected,
  options,
  thinkingEnabled,
  contextTokens,
  disabled,
  defaultProvider,
  onSelect,
  onOptions,
  onSettings,
}: {
  contextMeter?: ReactNode;
  choices: ModelChoice[];
  selected?: ModelChoice;
  options: ModelOptions;
  thinkingEnabled: boolean;
  contextTokens: number;
  disabled: boolean;
  defaultProvider: string;
  onSelect: (key: string) => void;
  onOptions: (patch: Partial<ModelOptions>) => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const control = selected?.model.thinking_control || "none";
  const levels = effortOptions.filter((option) =>
    selected?.model.reasoning_efforts?.includes(option.value),
  );
  const hasThinkingOverride =
    options.thinkingOverride !== undefined &&
    (options.thinkingOverride === false
      ? control !== "always"
      : !levels.length ||
        levels.some((level) => level.value === options.reasoningEffort));
  const activeEffort =
    hasThinkingOverride && options.thinkingOverride === true
      ? options.reasoningEffort
      : selected?.model.default_reasoning_effort;
  const thinkingValue = !thinkingEnabled
    ? "off"
    : levels.length
      ? activeEffort || "default"
      : "on";
  const thinkingSummary =
    control === "none"
      ? "不支持"
      : !thinkingEnabled
        ? "关闭"
        : levels.length
          ? effortLabel(activeEffort)
          : control === "always"
            ? "始终开启"
            : "开启";
  const canChooseThinking =
    control !== "none" && (control !== "always" || levels.length > 0);
  const capacities = contextPresets.includes(contextTokens)
    ? contextPresets
    : [...contextPresets, contextTokens].sort((a, b) => a - b);
  function changeThinking(value: string) {
    onOptions({
      thinkingOverride: value === "default" ? undefined : value !== "off",
      reasoningEffort: ["default", "off", "on"].includes(value)
        ? undefined
        : value,
    });
    setOpen(false);
  }
  return (
    <div className="composer-model-controls">
      {contextMeter}
      <DropdownMenu.Root
        open={open && !disabled}
        onOpenChange={setOpen}
        modal={false}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="composer-model"
            aria-label="选择模型"
            aria-description={
              selected
                ? `${selected.model.name}，思考强度：${thinkingSummary}`
                : undefined
            }
            disabled={disabled}
          >
            <span className="composer-model-name">
              {selected?.model.name || "选择模型"}
            </span>
            {selected && (
              <span className="composer-model-effort">
                {control === "none"
                  ? "无思考"
                  : thinkingEnabled
                    ? thinkingSummary
                    : "关闭思考"}
              </span>
            )}
            <ChevronDown
              size={12}
              strokeWidth={1.6}
              className="composer-model-chevron"
              aria-hidden="true"
            />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="composer-model-menu"
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            aria-label="模型与对话选项"
          >
            <DropdownMenu.Label className="composer-model-menu-heading">
              选择模型
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              className="composer-model-choices"
              value={selected?.key || ""}
              onValueChange={onSelect}
            >
              {choices
                .filter((choice) => choice.profile.key_configured)
                .map((choice) => (
                  <DropdownMenu.RadioItem
                    key={choice.key}
                    value={choice.key}
                    className="composer-model-choice"
                    disabled={disabled}
                    onSelect={keepMenuOpen}
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
                    <DropdownMenu.ItemIndicator>
                      <Check size={15} aria-hidden="true" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                ))}
              {!choices.some((choice) => choice.profile.key_configured) && (
                <p className="model-menu-current">尚未连接模型</p>
              )}
            </DropdownMenu.RadioGroup>
            {selected && (
              <DropdownMenu.Group className="composer-model-parameters">
                <DropdownMenu.Label className="composer-model-scope">
                  仅对当前对话生效
                </DropdownMenu.Label>
                {canChooseThinking ? (
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger
                      className="composer-model-parameter"
                      disabled={disabled}
                    >
                      <span>思考强度</span>
                      <span>
                        {thinkingSummary}
                        <ChevronRight size={13} aria-hidden="true" />
                      </span>
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.SubContent
                        className="composer-model-submenu"
                        sideOffset={6}
                        collisionPadding={12}
                        aria-label="思考强度"
                      >
                        <DropdownMenu.Label className="composer-model-menu-heading">
                          思考强度
                        </DropdownMenu.Label>
                        <DropdownMenu.RadioGroup
                          value={thinkingValue}
                          onValueChange={changeThinking}
                        >
                          {control !== "always" && (
                            <DropdownMenu.RadioItem
                              value="off"
                              className="composer-model-subitem"
                              onSelect={keepMenuOpen}
                            >
                              关闭
                              <DropdownMenu.ItemIndicator>
                                <Check size={14} aria-hidden="true" />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          )}
                          {levels.length ? (
                            levels.map((level) => (
                              <DropdownMenu.RadioItem
                                key={level.value}
                                value={level.value}
                                className="composer-model-subitem"
                                onSelect={keepMenuOpen}
                              >
                                {level.label}
                                <DropdownMenu.ItemIndicator>
                                  <Check size={14} aria-hidden="true" />
                                </DropdownMenu.ItemIndicator>
                              </DropdownMenu.RadioItem>
                            ))
                          ) : (
                            <DropdownMenu.RadioItem
                              value="on"
                              className="composer-model-subitem"
                              onSelect={keepMenuOpen}
                            >
                              开启
                              <DropdownMenu.ItemIndicator>
                                <Check size={14} aria-hidden="true" />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          )}
                          {thinkingValue === "default" && (
                            <DropdownMenu.RadioItem
                              value="default"
                              className="composer-model-subitem"
                              onSelect={keepMenuOpen}
                            >
                              服务商默认
                              <DropdownMenu.ItemIndicator>
                                <Check size={14} aria-hidden="true" />
                              </DropdownMenu.ItemIndicator>
                            </DropdownMenu.RadioItem>
                          )}
                        </DropdownMenu.RadioGroup>
                      </DropdownMenu.SubContent>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Sub>
                ) : (
                  <DropdownMenu.Item
                    className="composer-model-parameter"
                    disabled
                  >
                    <span>思考强度</span>
                    <span>{thinkingSummary}</span>
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger
                    className="composer-model-parameter"
                    disabled={disabled}
                  >
                    <span>上下文窗口</span>
                    <span>
                      {capacityLabel(contextTokens)}
                      <ChevronRight size={13} aria-hidden="true" />
                    </span>
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent
                      className="composer-model-submenu"
                      sideOffset={6}
                      collisionPadding={12}
                      aria-label="上下文窗口"
                    >
                      <DropdownMenu.Label className="composer-model-menu-heading">
                        上下文窗口
                      </DropdownMenu.Label>
                      <DropdownMenu.RadioGroup
                        value={String(contextTokens)}
                        onValueChange={(value) => {
                          onOptions({ contextTokens: Number(value) });
                          setOpen(false);
                        }}
                      >
                        {capacities.map((tokens) => (
                          <DropdownMenu.RadioItem
                            key={tokens}
                            value={String(tokens)}
                            className="composer-model-subitem"
                            onSelect={keepMenuOpen}
                          >
                            {capacityLabel(tokens)}
                            <DropdownMenu.ItemIndicator>
                              <Check size={14} aria-hidden="true" />
                            </DropdownMenu.ItemIndicator>
                          </DropdownMenu.RadioItem>
                        ))}
                      </DropdownMenu.RadioGroup>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              </DropdownMenu.Group>
            )}
            <DropdownMenu.Item
              className="composer-model-settings"
              onSelect={() => {
                setOpen(false);
                onSettings();
              }}
            >
              <Settings2 size={15} aria-hidden="true" />
              连接与设置
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
