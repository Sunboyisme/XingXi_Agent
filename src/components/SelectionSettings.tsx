import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "./ui/button";

export function SelectionSettings({
  enabled,
  shortcut,
  ownsShortcuts,
  shortcutError,
  busy,
  save,
}: {
  enabled: boolean;
  shortcut: string;
  ownsShortcuts: boolean;
  shortcutError: string;
  busy: boolean;
  save: (value: {
    selectionEnabled?: boolean;
    selectionShortcut?: string;
  }) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(shortcut);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const capture = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    setDraft(shortcut);
  }, [shortcut]);
  useEffect(() => {
    mounted.current = true;
    const blurred = () => {
      if (capture.current) {
        capture.current = false;
        setRecording(false);
        void invoke("selection_shortcut_recording", { recording: false }).catch(
          (cause) => {
            if (mounted.current) setError(String(cause));
          },
        );
      }
    };
    window.addEventListener("blur", blurred);
    return () => {
      window.removeEventListener("blur", blurred);
      mounted.current = false;
      capture.current = false;
      void invoke("selection_shortcut_recording", { recording: false }).catch(
        () => {},
      );
    };
  }, []);
  async function finish() {
    capture.current = false;
    if (mounted.current) setRecording(false);
    await invoke("selection_shortcut_recording", { recording: false });
  }
  return (
    <section className="settings-group">
      <h2>划词助手</h2>
      <div className="desktop-preference-card">
        <div className="desktop-feature-row">
          <div className="desktop-feature-copy">
            <strong>选中文字后唤出</strong>
            <p>按快捷键解释、翻译、总结或收藏选中文字；不读取剪贴板。</p>
          </div>
          <label className="module-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-label="开启划词助手"
              checked={enabled}
              disabled={busy || recording}
              onChange={(event) => {
                setNotice("");
                void save({ selectionEnabled: event.target.checked });
              }}
            />
            <span>{enabled ? "已开启" : "已关闭"}</span>
          </label>
        </div>
        <div className="selection-shortcut-settings">
          <div className="desktop-feature-copy">
            <strong>唤出快捷键</strong>
            <p>
              支持 Ctrl／Alt／Shift 加字母、数字或 F1–F12；录制时按 Esc 取消。
            </p>
          </div>
          <div className="selection-shortcut-controls">
            <Button
              variant="outline"
              className="selection-shortcut-recorder"
              aria-label={
                recording ? "正在录制快捷键，按 Esc 取消" : "录制划词快捷键"
              }
              disabled={busy}
              onBlur={() => {
                if (capture.current)
                  void finish().catch((cause) => setError(String(cause)));
              }}
              onClick={async () => {
                if (capture.current) return;
                capture.current = true;
                setError("");
                setNotice("");
                try {
                  await invoke("selection_shortcut_recording", {
                    recording: true,
                  });
                  if (!capture.current || !mounted.current) {
                    await invoke("selection_shortcut_recording", {
                      recording: false,
                    });
                    return;
                  }
                  setRecording(true);
                } catch (cause) {
                  capture.current = false;
                  if (mounted.current) setError(String(cause));
                }
              }}
              onKeyDown={(event) => {
                if (!capture.current) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") {
                  void finish().catch((cause) => setError(String(cause)));
                  return;
                }
                if (
                  ["Control", "Alt", "Shift", "Meta"].includes(event.key) ||
                  event.repeat
                )
                  return;
                const key = /^Key[A-Z]$/.test(event.code)
                  ? event.code.slice(3)
                  : /^Digit[0-9]$/.test(event.code)
                    ? event.code.slice(5)
                    : /^F([1-9]|1[0-2])$/.test(event.key)
                      ? event.key
                      : "";
                if (
                  event.metaKey ||
                  (!event.ctrlKey && !event.altKey) ||
                  !key
                ) {
                  setError(
                    "请使用 Ctrl 或 Alt 加字母、数字或 F1–F12，可同时按 Shift。",
                  );
                  return;
                }
                const value = [
                  event.ctrlKey && "Ctrl",
                  event.altKey && "Alt",
                  event.shiftKey && "Shift",
                  key,
                ]
                  .filter(Boolean)
                  .join("+");
                setDraft(value);
                setError("");
                void finish().catch((cause) => setError(String(cause)));
              }}
            >
              {recording
                ? "请按组合键…"
                : draft
                    .split("+")
                    .map((key, index) => (
                      <kbd key={`${key}-${index}`}>{key}</kbd>
                    ))}
            </Button>
            <Button
              variant="ghost"
              disabled={busy || recording || draft === "Ctrl+Shift+E"}
              onClick={() => {
                setDraft("Ctrl+Shift+E");
                setError("");
                setNotice("");
              }}
            >
              恢复默认
            </Button>
            <Button
              disabled={
                busy || recording || (draft === shortcut && !shortcutError)
              }
              onClick={async () => {
                setNotice("");
                if (await save({ selectionShortcut: draft }))
                  setNotice("快捷键已保存");
              }}
            >
              保存
            </Button>
          </div>
          {(error || shortcutError) && (
            <p className="field-error" role="alert">
              {error || shortcutError}
            </p>
          )}
          {!ownsShortcuts && enabled && (
            <p className="desktop-pet-feedback" role="status">
              另一个 XiaoXi 实例正在使用桌面快捷键，当前实例尚未接管。
            </p>
          )}
          {notice && (
            <p className="desktop-pet-feedback" role="status">
              {notice}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
