import { LoaderCircle } from "lucide-react";
import { Hint } from "./common";
import { MicrophoneIcon } from "./SoftIcons";
import type { SpeechInputController } from "@/lib/useSpeechInput";
import "../styles/speech-input.css";

const VOICE_BAR_FACTORS = [0.35, 0.65, 1, 0.65, 0.35];

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
  const level =
    v?.phase === "recording" && Number.isFinite(v.level)
      ? Math.min(1, Math.max(0, v.level) * 1.8)
      : 0;
  const state =
    v?.phase === "recording"
      ? `正在录音 ${Math.floor(v.seconds)} 秒，点击结束`
      : v?.phase === "transcribing"
        ? "正在识别，点击取消"
        : v?.phase === "starting"
          ? "正在打开麦克风，点击取消"
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
        {v?.phase === "recording" ? (
          <span className="speech-input-waves" aria-hidden="true">
            {VOICE_BAR_FACTORS.map((factor, i) => (
              <i
                key={i}
                style={{
                  transform: `scaleY(${(4 + level * 14 * factor) / 18})`,
                }}
              />
            ))}
          </span>
        ) : v?.phase === "starting" || v?.phase === "transcribing" ? (
          <LoaderCircle size={19} className="speech-input-spinner" />
        ) : (
          <MicrophoneIcon size={20} />
        )}
      </button>
    </Hint>
  );
}
