import { LoaderCircle, Mic, RotateCw } from "lucide-react";
import { Hint } from "./common";
import type { SpeechInputController } from "@/lib/useSpeechInput";
import "../styles/speech-input.css";

export function SpeechInputButton({
  speech,
  disabled = false,
  desktopShortcut = false,
}: {
  speech: SpeechInputController;
  disabled?: boolean;
  desktopShortcut?: boolean;
}) {
  const v = speech.voice;
  const state =
    v?.phase === "recording"
      ? `正在录音 ${Math.floor(v.seconds)} 秒，点击结束`
      : v?.phase === "transcribing"
        ? "正在识别，点击取消"
        : v?.phase === "starting"
          ? "正在打开麦克风，点击取消"
          : v?.retryable
            ? "识别未完成，点击重试，Esc 取消"
            : "";
  return (
    <Hint
      label={
        <span className="speech-input-hint">
          <span>
            {desktopShortcut ? (
              <>
                语音输入　按住 <kbd>右Alt</kbd>
              </>
            ) : (
              "语音输入　点击开始，再次点击结束"
            )}
          </span>
          {state && <span>{state}</span>}
        </span>
      }
    >
      <button
        type="button"
        className={`speech-input-button ${speech.busy ? "is-active" : ""} ${v?.phase === "recording" ? "is-recording" : ""}`}
        aria-label={state || "语音输入"}
        disabled={disabled && !speech.busy}
        onClick={speech.toggle}
      >
        {v?.phase === "starting" || v?.phase === "transcribing" ? (
          <LoaderCircle size={19} className="speech-input-spinner" />
        ) : v?.retryable ? (
          <RotateCw size={19} />
        ) : (
          <Mic size={19} />
        )}
        {v?.phase === "recording" && (
          <span className="speech-input-waves" aria-hidden="true">
            {[0.65, 1, 0.8].map((factor, i) => (
              <i
                key={i}
                style={{
                  height: `${4 + Math.min(1, v.level * 3) * 10 * factor}px`,
                }}
              />
            ))}
          </span>
        )}
      </button>
    </Hint>
  );
}
