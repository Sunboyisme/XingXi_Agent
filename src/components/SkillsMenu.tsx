import { useState } from "react";
import { ChevronDown, Loader2, Puzzle, Settings2 } from "lucide-react";
import { Popover } from "radix-ui";
import { api, type Skill } from "@/lib/api";

export function SkillsMenu({
  onSettings,
  open,
  onOpenChange,
}: {
  onSettings: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
      setSkills(await api<Skill[]>("/skills"));
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
    <Popover.Root
      open={open}
      onOpenChange={(value) => {
        if (value) void load(true);
        onOpenChange?.(value);
      }}
    >
      <Popover.Trigger asChild>
        <button
          className="composer-toolbox-trigger composer-skill-trigger"
          aria-label="技能"
        >
          <Puzzle size={15} />
          <span>技能</span>
          <ChevronDown size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="model-menu toolbox-menu skill-menu"
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={16}
        >
          <div role="menu" aria-label="技能">
            <p className="model-menu-label">技能</p>
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
                <button
                  type="button"
                  key={skill.id}
                  role="menuitemcheckbox"
                  aria-checked={skill.enabled}
                  disabled={Boolean(saving)}
                  className="model-menu-item toolbox-item"
                  onClick={() => void toggle(skill)}
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
              管理技能
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
