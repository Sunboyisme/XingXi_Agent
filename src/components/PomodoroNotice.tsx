import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pomodoroAction, usePomodoro } from "@/lib/pomodoro";
import { Button } from "./ui/button";
import { errorMessage } from "@/lib/utils";
import "../styles/pomodoro-notice.css";

export function PomodoroNotice() {
  const { data, busy } = usePomodoro();
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function act(action: "skip_break" | "start_break") {
    if (!data || saving.current) return;
    saving.current = true;
    setActing(true);
    setError("");
    const sequence = data.notification_seq;
    try {
      await pomodoroAction(action);
      await invoke("pomodoro_notice_close", { sequence });
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      saving.current = false;
      if (mounted.current) setActing(false);
    }
  }
  return (
    <section className="pomodoro-notice" aria-label="专注完成提醒">
      <header className="pomodoro-notice-heading">
        <span>XiaoXi · 休息提醒</span>
        <h1>专注了这么久，该休息了…</h1>
      </header>
      <p className="pomodoro-notice-description">起身走走，看看远处，让眼睛和肩颈都放松一下。</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="pomodoro-notice-actions">
        <Button
          variant="outline"
          disabled={busy || acting || data?.phase !== "waiting_break"}
          onClick={() => void act("skip_break")}
        >
          我知道了
        </Button>
        <Button
          disabled={busy || acting || data?.phase !== "waiting_break"}
          onClick={() => void act("start_break")}
        >
          进入休息
        </Button>
      </div>
    </section>
  );
}
