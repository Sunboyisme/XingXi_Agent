import { useState } from "react";
import { Loader2, Puzzle, Settings2 } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { api, type Skill } from "@/lib/api";
import { ToolMenuFrame } from "./ToolMenuFrame";

export function SkillsMenu({
  onSettings,
  open,
  onOpenChange,
  restoreFocus = true,
  asSubmenu = false,
}: {
  onSettings: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  restoreFocus?: boolean;
  asSubmenu?: boolean;
}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");

  async function load(open: boolean) {
    if (!open) return;
    setLoading(true);
    setError("");
    try {
      setSkills(
        (await api<Skill[]>("/skills")).sort((a, b) =>
          a.name.localeCompare(b.name, "zh-CN", {
            numeric: true,
            sensitivity: "base",
          }),
        ),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function toggle(skill: Skill) {
    setSaving(skill.id);
    setError("");
    try {
      const value = await api<Skill>(`/skills/${skill.id}`, "PATCH", {
        enabled: !skill.enabled,
      });
      setSkills((items) =>
        items.map((item) => (item.id === value.id ? value : item)),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving("");
    }
  }

  return (
    <ToolMenuFrame
      label="技能"
      icon={<Puzzle size={15} />}
      asSubmenu={asSubmenu}
      open={open}
      restoreFocus={restoreFocus}
      triggerClassName="composer-skill-trigger"
      contentClassName="skill-menu"
      onOpenChange={(value) => {
        if (value) void load(true);
        onOpenChange?.(value);
      }}
    >
      <DropdownMenu.Label className="model-menu-label">
        技能 · 全局生效
      </DropdownMenu.Label>
      <p className="toolbox-notice">影响所有对话的后续技能调用。</p>
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
      {!loading && !error && skills.length === 0 && (
        <p className="toolbox-notice">还没有导入技能</p>
      )}
      {!loading &&
        skills.map((skill) => (
          <DropdownMenu.CheckboxItem
            key={skill.id}
            checked={skill.enabled}
            disabled={Boolean(saving)}
            className="model-menu-item skill-menu-item"
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => void toggle(skill)}
          >
            <span className="toolbox-row-copy">
              <strong>{skill.name}</strong>
              <small>{skill.description || "没有填写说明"}</small>
            </span>
            <span
              className="mini-toggle"
              data-checked={skill.enabled}
              aria-hidden="true"
            >
              <span />
            </span>
          </DropdownMenu.CheckboxItem>
        ))}
      <DropdownMenu.Separator className="model-menu-separator" />
      <DropdownMenu.Item className="model-menu-item" onSelect={onSettings}>
        <Settings2 size={15} />
        管理技能
      </DropdownMenu.Item>
    </ToolMenuFrame>
  );
}
