import { Check, ChevronDown, Settings2, Sparkles } from "lucide-react";
import { Popover, RadioGroup } from "radix-ui";
import type { Settings } from "@/lib/api";
import type { ModelOptions } from "@/lib/chatModelPreferences";
import { effortLabel, effortOptions } from "@/lib/reasoningEffort";
import { useHoverPopover } from "@/lib/useHoverPopover";
import {
  ContextMeter,
  ContextSizeChoices,
  type ContextUsage,
} from "./ContextMeter";

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
  const menu = useHoverPopover(disabled);
  const contextMenu = useHoverPopover(disabled || !selected);
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
  const thinkingValue = !hasThinkingOverride
    ? "default"
    : !thinkingEnabled
      ? "off"
      : levels.some((level) => level.value === options.reasoningEffort)
        ? options.reasoningEffort
        : levels.length
          ? selected?.model.default_reasoning_effort || "default"
          : "on";
  function showModels() {
    contextMenu.onOpenChange(false);
    menu.show();
  }
  return (
    <div className="composer-model-controls">
      <ContextMeter
        menu={contextMenu}
        onOpen={() => menu.onOpenChange(false)}
        usage={usage}
        limit={contextTokens}
        defaultLimit={selected?.model.context_tokens ?? 500000}
        contextOverride={options.contextTokens}
        compacting={compacting}
        disabled={disabled || !selected}
        onCapacity={(contextTokens) => onOptions({ contextTokens })}
      />
      <Popover.Root open={menu.open} onOpenChange={menu.onOpenChange}>
        <Popover.Trigger asChild>
          <button
            ref={menu.trigger}
            type="button"
            className="composer-model"
            aria-label="选择模型"
            disabled={disabled}
            onPointerEnter={showModels}
            onPointerLeave={menu.scheduleClose}
            onFocus={() => {
              contextMenu.onOpenChange(false);
              menu.onFocus();
            }}
            onBlur={menu.onBlur}
            onClick={(event) => {
              event.preventDefault();
              showModels();
            }}
          >
            {thinkingEnabled && <Sparkles size={13} aria-hidden="true" />}
            <span>{selected?.model.name || "选择模型"}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            ref={menu.content}
            className="composer-model-menu"
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            aria-label="模型选择"
            onPointerEnter={menu.cancelClose}
            onPointerLeave={menu.scheduleClose}
            onFocusCapture={menu.cancelClose}
            onBlurCapture={menu.onBlur}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              menu.closeAndFocus();
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
              }}
            >
              {choices
                .filter((choice) => choice.profile.key_configured)
                .map((choice) => (
                  <RadioGroup.Item
                    key={choice.key}
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
                ))}
              {!choices.some((choice) => choice.profile.key_configured) && (
                <p className="model-menu-current">尚未连接模型</p>
              )}
            </RadioGroup.Root>
            {selected && (
              <div className="composer-quick-settings">
                <p>仅对当前对话生效</p>
                {control !== "none" &&
                  (control !== "always" || levels.length > 0) && (
                    <section
                      className="composer-quick-section"
                      aria-label="快捷思考设置"
                    >
                      <h3>思考{levels.length ? "强度" : "模式"}</h3>
                      <RadioGroup.Root
                        className="composer-thinking-choices"
                        aria-label="选择思考强度"
                        value={thinkingValue}
                        disabled={disabled}
                        onValueChange={(value) =>
                          onOptions({
                            thinkingOverride:
                              value === "default" ? undefined : value !== "off",
                            reasoningEffort: ["default", "off", "on"].includes(
                              value,
                            )
                              ? undefined
                              : value,
                          })
                        }
                      >
                        <RadioGroup.Item value="default">默认</RadioGroup.Item>
                        {control !== "always" && (
                          <RadioGroup.Item value="off">关闭</RadioGroup.Item>
                        )}
                        {levels.length ? (
                          levels.map((level) => (
                            <RadioGroup.Item
                              key={level.value}
                              value={level.value}
                            >
                              {level.label}
                            </RadioGroup.Item>
                          ))
                        ) : (
                          <RadioGroup.Item value="on">开启</RadioGroup.Item>
                        )}
                      </RadioGroup.Root>
                      <small>
                        模型默认：
                        {selected.model.default_thinking_enabled ||
                        control === "always"
                          ? levels.length
                            ? effortLabel(
                                selected.model.default_reasoning_effort,
                              )
                            : "开启"
                          : "关闭"}
                      </small>
                    </section>
                  )}
                <section
                  className="composer-quick-section"
                  aria-label="快捷上下文设置"
                >
                  <h3>上下文大小</h3>
                  <ContextSizeChoices
                    compact
                    value={options.contextTokens}
                    defaultLimit={selected.model.context_tokens ?? 500000}
                    disabled={disabled}
                    onChange={(contextTokens) => onOptions({ contextTokens })}
                  />
                </section>
              </div>
            )}
            <button
              type="button"
              className="composer-model-settings"
              onClick={() => {
                menu.onOpenChange(false);
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
