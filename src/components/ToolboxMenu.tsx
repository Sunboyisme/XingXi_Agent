import { useState } from "react";
import { ChevronDown, Layers2, Loader2, Settings2 } from "lucide-react";
import { Popover } from "radix-ui";
import { api, type Tool } from "@/lib/api";

export function ToolboxMenu({
  onSettings,
  open,
  onOpenChange,
}: {
  onSettings: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  async function load(open: boolean) {
    if (!open) return;
    setLoading(true);
    setError("");
    try {
      setTools((await api<Tool[]>("/tools")).filter((x) => x.source === "mcp"));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function toggle(tool: Tool) {
    setSaving(tool.id);
    setError("");
    try {
      const value = await api<Tool>(`/tools/${tool.id}`, "PATCH", {
        enabled: !tool.enabled,
      });
      setTools((items) => items.map((x) => (x.id === value.id ? value : x)));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving("");
    }
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        if (value) void load(true);
        onOpenChange?.(value);
      }}
    >
      <Popover.Trigger asChild>
        <button
          className="composer-toolbox-trigger"
          aria-label="MCP 工具"
        >
          <Layers2 size={15} />
          <span>MCP</span>
          <ChevronDown size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="model-menu toolbox-menu"
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={16}
        >
          <div role="menu" aria-label="MCP 工具">
            <p className="model-menu-label">MCP 工具</p>
            {loading && (
              <p className="toolbox-notice">
                <Loader2 size={14} className="spin" />
                正在读取…
              </p>
            )}
            {error && (
              <p className="toolbox-notice" role="alert">
                {error}
              </p>
            )}
            {!loading && !error && tools.length === 0 && (
              <p className="toolbox-notice">还没有配置 MCP 工具</p>
            )}
            {!loading &&
              tools.map((tool) => (
                <button
                  type="button"
                  key={tool.id}
                  role="menuitemcheckbox"
                  aria-checked={tool.enabled}
                  disabled={Boolean(saving)}
                  className="model-menu-item toolbox-item"
                  onClick={() => void toggle(tool)}
                >
                  <span className="toolbox-row-copy">
                    <strong>{tool.name}</strong>
                    <small>
                      {tool.source_label} ·{" "}
                      {tool.available ? tool.description : tool.note}
                    </small>
                  </span>
                  <span
                    className="mini-toggle"
                    data-checked={tool.enabled}
                    aria-hidden="true"
                  >
                    <span />
                  </span>
                </button>
              ))}
            <div className="model-menu-separator" />
            <button
              type="button"
              role="menuitem"
              className="model-menu-item"
              onClick={onSettings}
            >
              <Settings2 size={15} />
              配置 MCP
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
