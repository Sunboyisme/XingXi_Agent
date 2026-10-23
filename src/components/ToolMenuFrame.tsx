import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DropdownMenu } from "radix-ui";

export function ToolMenuFrame({
  label,
  icon,
  children,
  asSubmenu = false,
  open,
  onOpenChange,
  restoreFocus = true,
  triggerClassName = "",
  contentClassName = "",
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  asSubmenu?: boolean;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocus?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const menuClassName = `model-menu toolbox-menu ${contentClassName}`;
  if (asSubmenu)
    return (
      <DropdownMenu.Sub open={open} onOpenChange={onOpenChange}>
        <DropdownMenu.SubTrigger
          className="model-menu-item composer-add-menu-item"
          aria-label={label}
        >
          {icon}
          <span>{label}</span>
          <ChevronRight size={13} className="composer-add-menu-arrow" />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenu.SubContent
            aria-label={label}
            className={menuClassName}
            sideOffset={6}
            collisionPadding={16}
          >
            {children}
          </DropdownMenu.SubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    );
  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`composer-toolbox-trigger ${triggerClassName}`}
          aria-label={label}
        >
          {icon}
          <span>{label === "MCP 工具" ? "MCP" : label}</span>
          <ChevronDown size={13} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          onCloseAutoFocus={(event) => {
            if (!restoreFocus) event.preventDefault();
          }}
          aria-label={label}
          className={menuClassName}
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={16}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
