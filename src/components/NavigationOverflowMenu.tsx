import { DropdownMenu, Tooltip } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { Hint } from "./ui/hint";
import type { SoftIconProps } from "./SoftIcons";
import {
  setGeneralPreferences,
  useGeneralPreferences,
  type NavigationFeature,
} from "@/lib/generalPreferences";
import { useNavigationReorder } from "@/lib/useNavigationReorder";

export type NavigationFeatureItem = {
  id: NavigationFeature;
  label: string;
  icon: React.ComponentType<SoftIconProps>;
};

export function NavigationTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="navigation-tooltip"
          side="right"
          align="center"
          sideOffset={10}
          collisionPadding={10}
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function NavigationOverflowMenu({
  items,
  currentPage,
  onNavigate,
}: {
  items: NavigationFeatureItem[];
  currentPage: string;
  onNavigate: (page: NavigationFeature) => void;
}) {
  const { hiddenNavigation } = useGeneralPreferences();
  const reorder = useNavigationReorder();
  const orderedItems = reorder.order.flatMap((id) =>
    items.filter((item) => item.id === id),
  );
  const active = hiddenNavigation.some((id) => id === currentPage);
  return (
    <DropdownMenu.Root>
      <NavigationTooltip label="更多功能">
        <DropdownMenu.Trigger asChild>
          <button
            className={`navigation-more${active ? " active" : ""}`}
            aria-label="更多功能"
          >
            <MoreHorizontal size={20} fill="currentColor" strokeWidth={2.4} />
          </button>
        </DropdownMenu.Trigger>
      </NavigationTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="navigation-overflow-menu"
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          aria-label="更多功能"
          {...reorder.handlers}
          onCloseAutoFocus={() => reorder.cancel()}
        >
          <DropdownMenu.Label className="navigation-overflow-label">
            更多功能
          </DropdownMenu.Label>
          <p className="navigation-overflow-hint">
            按住功能上下拖动排序，选择要显示在侧栏的功能
          </p>
          {orderedItems.map((item) => {
            const visible = !hiddenNavigation.includes(item.id);
            return (
              <div
                className="navigation-overflow-row"
                key={item.id}
                data-feature={item.id}
                data-navigation-feature={item.id}
                data-reorder-dragging={
                  reorder.dragging === item.id || undefined
                }
                aria-description="按住上下拖动排序，或使用 Alt 加上下方向键"
              >
                <DropdownMenu.Item
                  className="navigation-overflow-link"
                  data-current={currentPage === item.id ? "true" : undefined}
                  onSelect={(event) => {
                    if (reorder.suppressSelect()) event.preventDefault();
                    else onNavigate(item.id);
                  }}
                >
                  <item.icon size={18} />
                  <span>{item.label}</span>
                </DropdownMenu.Item>
                <Hint
                  label={
                    visible ? `收起${item.label}` : `在侧栏显示${item.label}`
                  }
                >
                  <DropdownMenu.CheckboxItem
                    className="navigation-overflow-toggle"
                    data-navigation-toggle
                    checked={visible}
                    aria-label={`在侧栏显示${item.label}`}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) =>
                      setGeneralPreferences({
                        hiddenNavigation: checked
                          ? hiddenNavigation.filter((id) => id !== item.id)
                          : [...hiddenNavigation, item.id],
                      })
                    }
                  >
                    <span
                      className="navigation-visibility-switch"
                      aria-hidden="true"
                    >
                      <span />
                    </span>
                  </DropdownMenu.CheckboxItem>
                </Hint>
              </div>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
