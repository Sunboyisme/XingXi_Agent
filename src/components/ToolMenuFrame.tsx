import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DropdownMenu } from "radix-ui";

export function ToolMenuFrame({
  label,
  icon,
  children,
  onOpenChange,
  contentClassName = "",
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
  contentClassName?: string;
}) {
  const menuClassName = `model-menu toolbox-menu ${contentClassName}`;
  return (
    <DropdownMenu.Sub onOpenChange={onOpenChange}>
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
}
