import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Pause,
  Play,
  Plus,
  Settings2,
  SkipForward,
  Square,
  Trash2,
  Pencil,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ErrorNotice, Hint } from "./common";
import {
  formatCountdown,
  pomodoroAction,
  pomodoroStatus,
  primaryPomodoroAction,
  savePomodoroPreferences,
  usePomodoro,
  type Pomodoro,
  type PomodoroPreferences,
} from "@/lib/pomodoro";
import "../styles/pomodoro.css";

export function PomodoroPage() {
  const { data, error, busy, remaining, refresh } = usePomodoro();
  const [windowError, setWindowError] = useState("");
  const [presetPage, setPresetPage] = useState(0);
  const [dialog, setDialog] = useState<"add" | "settings" | null>(null);
  useEffect(() => {
    if (!data) return;
    const index = data.preferences.presets.findIndex(
      (preset) => preset.id === data.preferences.selected_preset,
    );
    setPresetPage(Math.max(0, Math.floor(index / 6)));
  }, [data?.preferences.selected_preset]);
  if (!data)
    return (
      <section className="pomodoro-page">
        <h1>番茄钟</h1>
        {error ? (
          <ErrorNotice message={error} retry={() => void refresh()} />
        ) : (
          <p role="status">正在读取番茄钟…</p>
        )}
      </section>
    );
  const primary = primaryPomodoroAction(data);
  const preset = data.preferences.presets.find(
    (p) => p.id === data.preferences.selected_preset,
  )!;
  const readyForFocus = data.phase === "idle" || data.phase === "waiting_focus";
  const pageCount = Math.ceil(data.preferences.presets.length / 6);
  const currentPage = Math.min(presetPage, pageCount - 1);
  const visiblePresets = data.preferences.presets.slice(
    currentPage * 6,
    currentPage * 6 + 6,
  );
  const isBreak = data.phase === "break" || data.phase === "waiting_break";
  const minutes = isBreak
    ? data.session!.break_minutes
    : readyForFocus
      ? preset.focus_minutes
      : data.session!.focus_minutes;
  const progress =
    data.status === "running" || data.status === "paused"
      ? Math.max(0, Math.min(1, 1 - remaining / (minutes * 60)))
      : 0;
  async function act(action: Parameters<typeof pomodoroAction>[0]) {
    setWindowError("");
    try {
      const next = await pomodoroAction(action);
      if (
        next?.phase === "focus" &&
        next.status === "running" &&
        (action === "start_focus" || action === "resume") &&
        isTauri()
      ) {
        try {
          await invoke("pomodoro_show_controls");
          await getCurrentWindow().hide();
        } catch {
          setWindowError("专注已开始，主窗口暂未收起，可以手动最小化。");
        }
      }
    } catch {
      /* The shared clock displays the failed action. */
    }
  }
  return (
    <section className="pomodoro-page">
      <header className="pomodoro-heading">
        <h1>番茄钟</h1>
        <Hint label="番茄钟设置">
          <Button
            variant="ghost"
            size="icon"
            aria-label="番茄钟设置"
            onClick={() => setDialog("settings")}
          >
            <Settings2 size={18} />
          </Button>
        </Hint>
      </header>
      {(windowError || error) && (
        <ErrorNotice
          message={windowError || error}
          retry={error ? () => void refresh() : undefined}
        />
      )}
      <div className="pomodoro-board">
        <section
          className="pomodoro-focus-card"
          aria-label="当前计时"
          data-status={data.status}
          data-phase={data.phase}
        >
          <div className="pomodoro-card-top">
            <span className="pomodoro-state">
              <i aria-hidden="true" />
              {pomodoroStatus(data)}
            </span>
          </div>
          <div
            className="pomodoro-dial"
            role="progressbar"
            aria-label="当前阶段进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <svg viewBox="0 0 280 280" aria-hidden="true">
              <circle
                className="pomodoro-ring-track"
                cx="140"
                cy="140"
                r="128"
              />
              <circle
                className="pomodoro-ring-progress"
                cx="140"
                cy="140"
                r="128"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={100 - progress * 100}
              />
            </svg>
            <div className="pomodoro-dial-copy">
              <span>{isBreak ? "休息时间" : "专注时间"}</span>
              <strong
                role="timer"
                aria-live="off"
                aria-label={`剩余 ${formatCountdown(remaining)}`}
              >
                {formatCountdown(remaining)}
              </strong>
              <span>
                {data.status === "paused"
                  ? "已暂停 · 等你继续"
                  : data.status === "waiting"
                    ? "准备好后，手动开始"
                    : `${minutes} 分钟${isBreak ? "休息" : "专注"}`}
              </span>
            </div>
          </div>
          <div className="pomodoro-controls">
            <Button
              className="pomodoro-primary"
              disabled={busy}
              onClick={() => void act(primary.action)}
            >
              {primary.action === "pause" ? (
                <Pause size={18} />
              ) : (
                <Play size={18} />
              )}
              {primary.label}
            </Button>
            {data.phase !== "idle" && (
              <Hint label="结束本轮，保留已专注时长">
                <Button
                  variant="ghost"
                  className="pomodoro-end"
                  disabled={busy}
                  onClick={() => void act("end")}
                >
                  <Square size={14} />
                  结束
                </Button>
              </Hint>
            )}
          </div>
          {isBreak && (
            <Button
              className="pomodoro-footnote"
              variant="ghost"
              disabled={busy}
              onClick={() => void act("skip_break")}
            >
              <SkipForward size={14} />
              跳过休息
            </Button>
          )}
        </section>
        <aside className="pomodoro-side">
          <section className="pomodoro-rhythm-card">
            <div className="pomodoro-section-heading">
              <h2>专注节奏</h2>
              <div className="pomodoro-preset-tools">
                {pageCount > 1 && (
                  <div className="pomodoro-preset-pages" aria-label="预设翻页">
                    <Hint label="上一组预设">
                      <button
                        type="button"
                        aria-label="上一组预设"
                        disabled={currentPage === 0}
                        onClick={() => setPresetPage(currentPage - 1)}
                      >
                        <ChevronLeft size={14} />
                      </button>
                    </Hint>
                    <span>
                      {currentPage + 1}/{pageCount}
                    </span>
                    <Hint label="下一组预设">
                      <button
                        type="button"
                        aria-label="下一组预设"
                        disabled={currentPage + 1 === pageCount}
                        onClick={() => setPresetPage(currentPage + 1)}
                      >
                        <ChevronRight size={14} />
                      </button>
                    </Hint>
                  </div>
                )}
                <Hint label="新增自定义预设">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="新增自定义预设"
                    onClick={() => setDialog("add")}
                  >
                    <Plus size={17} />
                  </Button>
                </Hint>
              </div>
            </div>
            <div
              className="pomodoro-presets"
              role="group"
              aria-label="专注与休息时长预设"
            >
              {visiblePresets.map((value) => (
                <Hint
                  key={value.id}
                  label={`专注 ${value.focus_minutes} 分钟，休息 ${value.break_minutes} 分钟；用于下一轮`}
                >
                  <button
                    type="button"
                    aria-pressed={value.id === preset.id}
                    disabled={busy}
                    onClick={() =>
                      void savePomodoroPreferences({
                        ...data.preferences,
                        selected_preset: value.id,
                      }).catch(() => {})
                    }
                  >
                    <span className="pomodoro-preset-focus">
                      <strong>{value.focus_minutes}</strong>
                      <span>分钟专注</span>
                    </span>
                    <span className="pomodoro-preset-break">
                      休息 {value.break_minutes} 分钟
                    </span>
                    {value.id === preset.id && (
                      <Check className="pomodoro-preset-check" size={14} />
                    )}
                  </button>
                </Hint>
              ))}
            </div>
          </section>
          <section className="pomodoro-history-card">
            <div className="pomodoro-section-heading">
              <h2>专注积累</h2>
            </div>
            <div className="pomodoro-statistics" aria-label="专注统计">
              {(
                [
                  [
                    Math.floor(data.statistics.today_seconds / 60),
                    "今日时长",
                    true,
                  ],
                  [
                    Math.floor(data.statistics.week_seconds / 60),
                    "本周时长",
                    true,
                  ],
                  [
                    Math.floor(data.statistics.total_seconds / 60),
                    "总计时长",
                    true,
                  ],
                  [data.statistics.completed_rounds, "完成轮次", false],
                ] as const
              ).map(([value, label, isTime]) => (
                <div key={label}>
                  <span>{label}</span>
                  <p>
                    <strong>{value.toLocaleString()}</strong>
                    <span>{isTime ? "分钟" : "轮"}</span>
                  </p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
      {dialog && (
        <PomodoroSettings
          data={data}
          mode={dialog}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

function PomodoroSettings({
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
  const [focus, setFocus] = useState("25");
  const [rest, setRest] = useState("5");
  const [editing, setEditing] = useState<string>();
  const [errors, setErrors] = useState({ focus: "", rest: "", form: "" });
  const [saving, setSaving] = useState(false);
  const custom = preferences.presets.filter(
    (p) => !p.id.startsWith("builtin-"),
  );
  function addPreset() {
    const f = /^\d+$/.test(focus) ? Number(focus) : NaN;
    const b = /^\d+$/.test(rest) ? Number(rest) : NaN;
    const nextErrors = {
      focus:
        !Number.isInteger(f) || f < 1 || f > 180
          ? "请输入 1–180 的整数分钟"
          : "",
      rest:
        !Number.isInteger(b) || b < 1 || b > 60 ? "请输入 1–60 的整数分钟" : "",
      form: "",
    };
    setErrors(nextErrors);
    if (nextErrors.focus || nextErrors.rest) return;
    if (!editing && preferences.presets.length >= 24) {
      setErrors({
        ...nextErrors,
        form: "最多保存 20 个自定义预设，请先删除不需要的预设。",
      });
      return;
    }
    const preset = {
      id: editing || crypto.randomUUID(),
      focus_minutes: f,
      break_minutes: b,
    };
    const next = {
      ...preferences,
      selected_preset: preset.id,
      presets: editing
        ? preferences.presets.map((p) => (p.id === editing ? preset : p))
        : [...preferences.presets, preset],
    };
    setPreferences(next);
    setEditing(undefined);
    return next;
  }
  async function save(value: PomodoroPreferences) {
    if (JSON.stringify(data.preferences) !== originalPreferences.current) {
      setErrors((old) => ({
        ...old,
        form: "设置已在另一窗口更新，请关闭后重新打开。",
      }));
      return;
    }
    setSaving(true);
    try {
      await savePomodoroPreferences(value, data.revision);
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="pomodoro-settings">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "自定义专注节奏" : "番茄钟设置"}
          </DialogTitle>
          <DialogDescription>
            专注与休息都由你手动开始，时长修改用于下一轮。
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === "add") {
              const next = addPreset();
              if (next) void save(next);
            } else void save(preferences);
          }}
        >
          {mode === "settings" && (
            <>
              <label className="pomodoro-sound">
                <span>到时播放一声短提示音</span>
                <input
                  type="checkbox"
                  checked={preferences.sound_enabled}
                  disabled={saving}
                  onChange={(event) =>
                    setPreferences((old) => ({
                      ...old,
                      sound_enabled: event.target.checked,
                    }))
                  }
                />
              </label>
              <div className="pomodoro-custom-list">
                <strong>自定义预设</strong>
                {!custom.length && <p>还没有自定义预设，可以在下方添加。</p>}
                {custom.map((p) => (
                  <div key={p.id}>
                    <span>
                      专注 {p.focus_minutes} 分钟 / 休息 {p.break_minutes} 分钟
                    </span>
                    <Hint label="编辑预设">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={saving}
                        aria-label={`编辑 ${p.focus_minutes}/${p.break_minutes} 预设`}
                        onClick={() => {
                          setEditing(p.id);
                          setFocus(String(p.focus_minutes));
                          setRest(String(p.break_minutes));
                        }}
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
                        aria-label={`删除 ${p.focus_minutes}/${p.break_minutes} 预设`}
                        onClick={() => {
                          setPreferences((old) => ({
                            ...old,
                            presets: old.presets.filter((v) => v.id !== p.id),
                            selected_preset:
                              old.selected_preset === p.id
                                ? "builtin-25-5"
                                : old.selected_preset,
                          }));
                          if (editing === p.id) setEditing(undefined);
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </Hint>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="pomodoro-duration-fields">
            <label htmlFor="pomodoro-focus-minutes">
              专注（分钟）
              <Input
                id="pomodoro-focus-minutes"
                inputMode="numeric"
                value={focus}
                disabled={saving}
                onChange={(event) => setFocus(event.target.value)}
                aria-invalid={Boolean(errors.focus)}
                aria-describedby={
                  errors.focus ? "pomodoro-focus-error" : undefined
                }
              />
              {errors.focus && (
                <span className="field-error" id="pomodoro-focus-error">
                  {errors.focus}
                </span>
              )}
            </label>
            <label htmlFor="pomodoro-break-minutes">
              休息（分钟）
              <Input
                id="pomodoro-break-minutes"
                inputMode="numeric"
                value={rest}
                disabled={saving}
                onChange={(event) => setRest(event.target.value)}
                aria-invalid={Boolean(errors.rest)}
                aria-describedby={
                  errors.rest ? "pomodoro-break-error" : undefined
                }
              />
              {errors.rest && (
                <span className="field-error" id="pomodoro-break-error">
                  {errors.rest}
                </span>
              )}
            </label>
          </div>
          {mode === "settings" && (
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => addPreset()}
            >
              {editing ? "更新这个预设" : "添加预设"}
            </Button>
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
