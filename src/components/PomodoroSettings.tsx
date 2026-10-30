import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pencil, Plus, Trash2, Volume2 } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { SoftSelect } from "./ui/soft-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Hint } from "./common";
import {
  savePomodoroPreferences,
  orderedPomodoroPresets,
  type Pomodoro,
  type PomodoroPreferences,
} from "@/lib/pomodoro";

const emptyErrors = { focus: "", rest: "", form: "" };
const durations = [
  { key: "focus", label: "专注（分钟）", max: 180 },
  { key: "rest", label: "休息（分钟）", max: 60 },
] as const;

export function PomodoroSettings({
  data,
  mode,
  onClose,
}: {
  data: Pomodoro;
  mode: "add" | "settings";
  onClose: () => void;
}) {
  const [preferences, setPreferences] = useState<PomodoroPreferences>(
    data.preferences,
  );
  const originalPreferences = useRef(JSON.stringify(data.preferences));
  const [editing, setEditing] = useState<string | undefined>(() =>
    mode === "add" ? crypto.randomUUID() : undefined,
  );
  const [draft, setDraft] = useState(() => {
    const selected = data.preferences.presets.find(
      (preset) => preset.id === data.preferences.selected_preset,
    )!;
    return {
      focus: String(selected.focus_minutes),
      rest: String(selected.break_minutes),
    };
  });
  const [errors, setErrors] = useState(emptyErrors);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [soundError, setSoundError] = useState("");
  const focusInput = useRef<HTMLInputElement>(null);
  const restInput = useRef<HTMLInputElement>(null);
  const custom = preferences.presets.filter(
    (preset) => !preset.id.startsWith("builtin-"),
  );
  const existing = preferences.presets.find((preset) => preset.id === editing);
  const presets = orderedPomodoroPresets(preferences.presets);
  useEffect(() => {
    if (editing) focusInput.current?.focus();
  }, [editing]);

  function applyDraft(): PomodoroPreferences | undefined {
    if (!editing) return preferences;
    const values = { focus: Number(draft.focus), rest: Number(draft.rest) };
    const nextErrors = { ...emptyErrors };
    for (const field of durations) {
      const value = values[field.key];
      if (
        !/^\d+$/.test(draft[field.key]) ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > field.max
      )
        nextErrors[field.key] = `请输入 1–${field.max} 的整数分钟`;
    }
    if (!existing && preferences.presets.length >= 24)
      nextErrors.form = "最多保存 20 个自定义预设，请先删除不需要的预设。";
    setErrors(nextErrors);
    if (nextErrors.focus || nextErrors.rest || nextErrors.form) {
      if (nextErrors.focus) focusInput.current?.focus();
      else if (nextErrors.rest) restInput.current?.focus();
      return;
    }
    const preset = {
      id: editing,
      focus_minutes: values.focus,
      break_minutes: values.rest,
    };
    return {
      ...preferences,
      selected_preset: existing ? preferences.selected_preset : preset.id,
      presets: existing
        ? preferences.presets.map((value) =>
            value.id === editing ? preset : value,
          )
        : [...preferences.presets, preset],
    };
  }
  function edit(id?: string) {
    const next = applyDraft();
    if (!next) return;
    const preset = next.presets.find(
      (value) => value.id === (id || next.selected_preset),
    )!;
    setPreferences(next);
    setEditing(id || crypto.randomUUID());
    setDraft({
      focus: String(preset.focus_minutes),
      rest: String(preset.break_minutes),
    });
    setErrors(emptyErrors);
  }
  async function save() {
    if (saving) return;
    if (JSON.stringify(data.preferences) !== originalPreferences.current) {
      setErrors((old) => ({
        ...old,
        form: "设置已在另一窗口更新，请关闭后重新打开。",
      }));
      return;
    }
    const next = applyDraft();
    if (!next) return;
    setSaving(true);
    try {
      await savePomodoroPreferences(next, data.revision);
      onClose();
    } catch (cause) {
      setErrors((old) => ({
        ...old,
        form: cause instanceof Error ? cause.message : "保存失败，请重试。",
      }));
    } finally {
      setSaving(false);
    }
  }
  async function previewSound() {
    if (previewing) return;
    setSoundError("");
    setPreviewing(true);
    try {
      await invoke("pomodoro_preview_sound");
    } catch {
      setSoundError("提示音暂时无法播放，请稍后再试。");
    } finally {
      setPreviewing(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="pomodoro-settings" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "自定义专注节奏" : "番茄钟设置"}
          </DialogTitle>
          <DialogDescription>
            桌宠与主页面共用默认时长，修改用于下一轮专注。
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {mode === "settings" && (
            <>
              <div className="pomodoro-default-duration">
                <label htmlFor="pomodoro-default-duration">默认时长</label>
                <SoftSelect
                  id="pomodoro-default-duration"
                  label="默认时长"
                  value={preferences.selected_preset}
                  disabled={saving}
                  onValueChange={(value) =>
                    setPreferences((old) => ({
                      ...old,
                      selected_preset: value,
                    }))
                  }
                  options={presets.map((preset) => ({
                    value: preset.id,
                    label: `专注 ${preset.focus_minutes} 分钟 / 休息 ${preset.break_minutes} 分钟`,
                  }))}
                />
              </div>
              <div>
                <div className="pomodoro-sound">
                  <label htmlFor="pomodoro-sound-enabled">完成提示音</label>
                  <div className="pomodoro-sound-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={saving || previewing}
                      aria-label="试听完成提示音"
                      onClick={() => void previewSound()}
                    >
                      <Volume2 size={15} />
                      {previewing ? "播放中" : "试听"}
                    </Button>
                    <Checkbox
                      id="pomodoro-sound-enabled"
                      checked={preferences.sound_enabled}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        setPreferences((old) => ({
                          ...old,
                          sound_enabled: checked === true,
                        }))
                      }
                    />
                  </div>
                </div>
                {soundError && (
                  <p className="field-error" role="alert">
                    {soundError}
                  </p>
                )}
              </div>
              <div className="pomodoro-custom-list">
                <strong>自定义预设</strong>
                {!custom.length && <p>还没有自定义预设。</p>}
                {custom.map((preset) => (
                  <div key={preset.id}>
                    <span>
                      专注 {preset.focus_minutes} 分钟 / 休息{" "}
                      {preset.break_minutes} 分钟
                    </span>
                    <Hint label="编辑预设">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={saving}
                        aria-label={`编辑 ${preset.focus_minutes}/${preset.break_minutes} 预设`}
                        onClick={() => edit(preset.id)}
                      >
                        <Pencil size={15} />
                      </Button>
                    </Hint>
                    <Hint label="删除预设">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={saving}
                        aria-label={`删除 ${preset.focus_minutes}/${preset.break_minutes} 预设`}
                        onClick={() => {
                          setPreferences((old) => ({
                            ...old,
                            presets: old.presets.filter(
                              (value) => value.id !== preset.id,
                            ),
                            selected_preset:
                              old.selected_preset === preset.id
                                ? "builtin-25-5"
                                : old.selected_preset,
                          }));
                          if (editing === preset.id) setEditing(undefined);
                          setErrors(emptyErrors);
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </Hint>
                  </div>
                ))}
              </div>
              {!editing && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={saving}
                  onClick={() => edit()}
                >
                  <Plus size={15} />
                  新增预设
                </Button>
              )}
            </>
          )}
          {editing && (
            <div className="pomodoro-editor">
              {mode === "settings" && (
                <div className="pomodoro-editor-heading">
                  <strong>{existing ? "编辑预设" : "新增预设"}</strong>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setEditing(undefined);
                      setErrors(emptyErrors);
                    }}
                  >
                    取消编辑
                  </Button>
                </div>
              )}
              <div className="pomodoro-duration-fields">
                {durations.map((field) => (
                  <label
                    key={field.key}
                    htmlFor={`pomodoro-${field.key}-minutes`}
                  >
                    {field.label}
                    <Input
                      ref={field.key === "focus" ? focusInput : restInput}
                      id={`pomodoro-${field.key}-minutes`}
                      inputMode="numeric"
                      value={draft[field.key]}
                      disabled={saving}
                      onChange={(event) => {
                        setDraft((old) => ({
                          ...old,
                          [field.key]: event.target.value,
                        }));
                        setErrors((old) => ({
                          ...old,
                          [field.key]: "",
                          form: "",
                        }));
                      }}
                      aria-invalid={Boolean(errors[field.key])}
                      aria-describedby={
                        errors[field.key]
                          ? `pomodoro-${field.key}-error`
                          : undefined
                      }
                    />
                    {errors[field.key] && (
                      <span
                        className="field-error"
                        id={`pomodoro-${field.key}-error`}
                      >
                        {errors[field.key]}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}
          {errors.form && (
            <p className="field-error" role="alert">
              {errors.form}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving
                ? "正在保存…"
                : mode === "add"
                  ? "添加并使用"
                  : "保存设置"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
