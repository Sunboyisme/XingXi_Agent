import { DropdownMenu } from "radix-ui";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import {
  setGeneralPreferences,
  useGeneralPreferences,
  type NavigationFeature,
} from "@/lib/generalPreferences";

export type NavigationFeatureItem = {
  id: NavigationFeature;
  label: string;
  icon: LucideIcon;
};

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
  const active = hiddenNavigation.some((id) => id === currentPage);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={`navigation-more${active ? " active" : ""}`}
          aria-label="更多功能"
          title="更多功能"
        >
          <MoreHorizontal size={20} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="navigation-overflow-menu"
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          aria-label="更多功能"
        >
          <DropdownMenu.Label className="navigation-overflow-label">
            更多功能
          </DropdownMenu.Label>
          <p className="navigation-overflow-hint">选择要显示在侧栏的功能</p>
          {items.map((item) => {
            const visible = !hiddenNavigation.includes(item.id);
            return (
              <div className="navigation-overflow-row" key={item.id}>
                <DropdownMenu.Item
                  className="navigation-overflow-link"
                  data-current={currentPage === item.id ? "true" : undefined}
                  onSelect={() => onNavigate(item.id)}
                >
                  <item.icon size={18} />
                  <span>{item.label}</span>
                </DropdownMenu.Item>
                <DropdownMenu.CheckboxItem
                  className="navigation-overflow-toggle"
                  checked={visible}
                  aria-label={`在侧栏显示${item.label}`}
                  title={
                    visible ? `收起${item.label}` : `在侧栏显示${item.label}`
                  }
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
              </div>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
