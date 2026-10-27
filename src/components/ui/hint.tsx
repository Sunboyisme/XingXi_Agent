import { Tooltip } from "radix-ui";

/** 统一的悬浮提示样式，替代浏览器原生 title。 */
export function Hint({
  label,
  side = "top",
  children,
}: {
  label?: string;
  side?: "top" | "right" | "bottom" | "left";
  children: React.ReactElement;
}) {
  if (!label) return children;
  return (
    <Tooltip.Provider delayDuration={260} skipDelayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="ui-hint"
            side={side}
            sideOffset={7}
            collisionPadding={8}
          >
            {label}
            <Tooltip.Arrow className="ui-hint-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
