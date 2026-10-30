import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Pause,
  Play,
  Plus,
  Settings2,
  SkipForward,
  Square,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "./ui/button";
import { PomodoroSettings } from "./PomodoroSettings";
import { ErrorNotice, Hint } from "./common";
import {
  formatCountdown,
  pomodoroAction,
  pomodoroStatus,
  primaryPomodoroAction,
  savePomodoroPreferences,
  usePomodoro,
} from "@/lib/pomodoro";
import "../styles/pomodoro.css";

const presetsPerPage = 4;

export function PomodoroPage() {
  const { data, error, busy, remaining, refresh } = usePomodoro();
  const [windowError, setWindowError] = useState("");
  const [presetPage, setPresetPage] = useState(0);
  const [dialog, setDialog] = useState<"add" | "settings" | null>(null);
  const selectedPresetIndex =
    data?.preferences.presets.findIndex(
      (preset) => preset.id === data.preferences.selected_preset,
    ) ?? 0;
  useEffect(() => {
    setPresetPage(
      Math.max(0, Math.floor(selectedPresetIndex / presetsPerPage)),
    );
  }, [data?.preferences.selected_preset, selectedPresetIndex]);
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
  const pageCount = Math.ceil(data.preferences.presets.length / presetsPerPage);
  const currentPage = Math.min(presetPage, pageCount - 1);
  const visiblePresets = data.preferences.presets.slice(
    currentPage * presetsPerPage,
    (currentPage + 1) * presetsPerPage,
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
          <div className="pomodoro-focus-content">
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
                  visibility={progress > 0 ? "visible" : "hidden"}
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
                <Button
                  variant="ghost"
                  className="pomodoro-end"
                  aria-label="结束本轮"
                  disabled={busy}
                  onClick={() => void act("end")}
                >
                  <Square size={14} />
                  <span>结束</span>
                </Button>
              )}
            </div>
            {isBreak && (
              <Button
                className="pomodoro-skip"
                variant="ghost"
                disabled={busy}
                onClick={() => void act("skip_break")}
              >
                <SkipForward size={14} />
                跳过休息
              </Button>
            )}
          </div>
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
                <button
                  key={value.id}
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
