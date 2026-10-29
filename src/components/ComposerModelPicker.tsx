import { Check, ChevronDown, Settings2, Sparkles } from "lucide-react";
import { Popover, RadioGroup } from "radix-ui";
import type { Settings } from "@/lib/api";
import { useHoverPopover } from "@/lib/useHoverPopover";
import { Hint } from "./common";
import { ContextMeter, type ContextUsage } from "./ContextMeter";

type ModelChoice = {
  key: string;
  model: Settings["providers"][number]["models"][number];
  profile: Settings["providers"][number];
};

export function ComposerModelPicker({
  choices,
  selected,
  thinkingEnabled,
  contextTokens,
  contextOverride,
  usage,
  compacting,
  disabled,
  defaultProvider,
  onSelect,
  onContextChange,
  onSettings,
}: {
  choices: ModelChoice[];
  selected?: ModelChoice;
  thinkingEnabled: boolean;
  contextTokens: number;
  contextOverride?: number;
  usage: ContextUsage | null;
  compacting: boolean;
  disabled: boolean;
  defaultProvider: string;
  onSelect: (key: string) => void;
  onContextChange: (tokens?: number) => void;
  onSettings: () => void;
}) {
  const menu = useHoverPopover(disabled);
  const contextMenu = useHoverPopover(disabled || !selected);
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
        contextOverride={contextOverride}
        compacting={compacting}
        disabled={disabled || !selected}
        onCapacity={onContextChange}
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
                menu.closeAndFocus();
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
