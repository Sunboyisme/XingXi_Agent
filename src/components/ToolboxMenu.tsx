import { useState } from "react";
import { Layers2, Loader2, Settings2 } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { api, type Tool } from "@/lib/api";
import { ToolMenuFrame } from "./ToolMenuFrame";
import { errorMessage } from "@/lib/utils";

export function ToolboxMenu({ onSettings }: { onSettings: () => void }) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      setTools((await api<Tool[]>("/tools")).filter((x) => x.source === "mcp"));
    } catch (error) {
      setError(errorMessage(error));
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
      setError(errorMessage(error));
    } finally {
      setSaving("");
    }
  }
  return (
    <ToolMenuFrame
      label="MCP 工具"
      icon={<Layers2 size={15} />}
      onOpenChange={(value) => {
        if (value) void load();
      }}
    >
      <DropdownMenu.Label className="model-menu-label">
        MCP 工具
      </DropdownMenu.Label>
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
          <DropdownMenu.CheckboxItem
            key={tool.id}
            checked={tool.enabled}
            disabled={Boolean(saving)}
            className="model-menu-item toolbox-item"
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => void toggle(tool)}
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
          </DropdownMenu.CheckboxItem>
        ))}
      <DropdownMenu.Separator className="model-menu-separator" />
      <DropdownMenu.Item className="model-menu-item" onSelect={onSettings}>
        <Settings2 size={15} />
        配置 MCP
      </DropdownMenu.Item>
    </ToolMenuFrame>
  );
}
