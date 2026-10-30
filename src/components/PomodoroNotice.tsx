import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { pomodoroAction, usePomodoro } from "@/lib/pomodoro";
import { Button } from "./ui/button";
import { errorMessage } from "@/lib/utils";
import "../styles/pomodoro-notice.css";

export function PomodoroNotice() {
  const { data, busy } = usePomodoro();
  const [error, setError] = useState("");
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
    setError("");
    const sequence = data.notification_seq;
    try {
      await pomodoroAction(action);
      await invoke("pomodoro_notice_close", { sequence });
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      saving.current = false;
    }
  }
  return (
    <section className="pomodoro-notice" aria-label="专注完成提醒">
      <strong>这一段专注完成了</strong>
      <p>休息一下，再继续下一段。</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div>
        <Button
          variant="ghost"
          disabled={busy || data?.phase !== "waiting_break"}
          onClick={() => void act("skip_break")}
        >
          知道了
        </Button>
        <Button
          disabled={busy || data?.phase !== "waiting_break"}
          onClick={() => void act("start_break")}
        >
          休息一会
        </Button>
      </div>
    </section>
  );
}
