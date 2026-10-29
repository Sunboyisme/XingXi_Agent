import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Mic, RotateCcw, Loader2, Undo2 } from "lucide-react";
import {
  api,
  invoke,
  desktopListen,
  desktopError,
  type DesktopPreferences,
  type SpeechSettings,
} from "@/lib/desktopAssistant";
import { ErrorNotice } from "./common";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SoftSelect } from "./ui/soft-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { ConnectionCard } from "./ConnectionCard";
import "../styles/desktop-settings.css";
type DesktopStatus = {
  preferences: DesktopPreferences;
  ownsShortcuts: boolean;
  shortcutError?: string;
};
function Keycaps({ value }: { value: string }) {
  return (
    <span className="desktop-keycaps" aria-label={value}>
      {value
        .split("+")
        .filter(Boolean)
        .map((key, index) => (
          <kbd key={`${index}-${key}`}>{key}</kbd>
        ))}
    </span>
  );
}
export function DesktopSettings() {
  const [status, setStatus] = useState<DesktopStatus>();
  const [shortcut, setShortcut] = useState("");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [keyError, setKeyError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const recordingRef = useRef(false);
  const recordEpoch = useRef(0);
  const mounted = useRef(false);
  const saving = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!isTauri()) return;
    const accept = (value: DesktopStatus) => {
      if (!mounted.current) return;
      setStatus(value);
      if (!recordingRef.current)
        setShortcut((current) => current || value.preferences.shortcut);
    };
    const listener = desktopListen<DesktopStatus>(
      "desktop-preferences",
      accept,
    );
    void listener
      .then(() => invoke<DesktopStatus>("desktop_preferences"))
      .then((value) => {
        if (mounted.current) {
          accept(value);
          setShortcut(value.preferences.shortcut);
        }
      })
      .catch((e) => {
        if (mounted.current) setError(desktopError(e));
      });
    return () => {
      mounted.current = false;
      recordEpoch.current++;
      recordingRef.current = false;
      void invoke("desktop_shortcut_recording", { recording: false }).catch(
        () => {},
      );
      void listener.then((f) => f());
    };
  }, []);
  async function stopRecording() {
    recordEpoch.current++;
    recordingRef.current = false;
    setRecording(false);
    await invoke("desktop_shortcut_recording", { recording: false }).catch(
      (e) => {
        if (mounted.current) setKeyError(desktopError(e));
      },
    );
  }
  async function beginRecording() {
    const epoch = ++recordEpoch.current;
    setNotice("");
    setKeyError("");
    try {
      await invoke("desktop_shortcut_recording", { recording: true });
      if (!mounted.current || epoch !== recordEpoch.current) {
        await invoke("desktop_shortcut_recording", { recording: false });
        return;
      }
      recordingRef.current = true;
      setRecording(true);
      button.current?.focus();
    } catch (e) {
      if (mounted.current) setKeyError(desktopError(e));
    }
  }
  function captureKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (!recordingRef.current) return;
    if (e.key === "Tab") {
      void stopRecording();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setShortcut(status?.preferences.shortcut || "Ctrl+Shift+E");
      void stopRecording();
      return;
    }
    if (e.repeat || e.nativeEvent.isComposing) return;
    const key = /^Key[A-Z]$/.test(e.code)
      ? e.code.slice(3)
      : /^Digit[0-9]$/.test(e.code)
        ? e.code.slice(5)
        : /^F([1-9]|1[0-2])$/.test(e.code)
          ? e.code
          : "";
    if (!key) {
      setKeyError("请同时按下修饰键和字母、数字或功能键");
      return;
    }
    const parts = [
      e.ctrlKey ? "Ctrl" : "",
      e.shiftKey ? "Shift" : "",
      e.altKey ? "Alt" : "",
      e.metaKey ? "Win" : "",
      key,
    ].filter(Boolean);
    if (parts.length < 2) {
      setKeyError("请至少加上 Ctrl、Shift、Alt 或 Win 中的一个");
      return;
    }
    setShortcut(parts.join("+"));
    setKeyError("");
    void stopRecording();
  }
  async function save(change: Partial<DesktopPreferences>) {
    if (saving.current || !status) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    if (change.shortcut) setKeyError("");
    try {
      const value = await invoke<DesktopStatus>("desktop_preferences_save", {
        preferences: change,
      });
      if (!mounted.current) return;
      setStatus(value);
      if (change.shortcut) {
        setShortcut(value.preferences.shortcut);
        setNotice("快捷键已保存");
      }
    } catch (e) {
      if (change.shortcut) setKeyError(desktopError(e));
      else setError(desktopError(e));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!isTauri()) return <p>桌面截图问答、桌宠和划词助手仅在桌面版中可用。</p>;
  function featureRow(
    key: "enabled" | "pet" | "selection",
    label: string,
    detail: string,
  ) {
    return (
      <div className="desktop-feature-row">
        <div className="desktop-feature-copy">
          <strong>{label}</strong>
          <p>{detail}</p>
        </div>
        <div className="desktop-feature-action">
          {key === "enabled" && <Keycaps value="右 Alt" />}
          <label className="module-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-label={label}
              disabled={!status || busy || recording}
              checked={status?.preferences[key] || false}
              onChange={(event) => void save({ [key]: event.target.checked })}
            />
            <span>{status?.preferences[key] ? "已开启" : "已关闭"}</span>
          </label>
        </div>
      </div>
    );
  }
  return (
    <section className="desktop-preferences" aria-label="桌面助手设置">
      <section className="settings-group">
        <h2>桌面功能</h2>
        <div className="desktop-preference-card">
          {featureRow(
            "enabled",
            "桌面截图问答",
            "短按右 Alt 唤出问答，按住右 Alt 语音输入。",
          )}
          {featureRow(
            "pet",
            "桌面 XiaoXi",
            "在桌面显示 XiaoXi，拖动调整位置，点击唤出问答。",
          )}
        </div>
      </section>
      <section className="settings-group">
        <h2>划词助手</h2>
        <div className="desktop-preference-card">
          {featureRow(
            "selection",
            "手动划词助手",
            "选中文字后，按快捷键打开解释、翻译和总结工具。",
          )}
          <div className="desktop-shortcut-setting">
            <div className="desktop-shortcut-heading">
              <strong>唤起快捷键</strong>
              <p>点击键帽录制组合键，Esc 取消。</p>
            </div>
            <div className="desktop-shortcut-editor">
              <button
                ref={button}
                type="button"
                className={`desktop-shortcut-recorder ${recording ? "is-recording" : ""}`}
                aria-label={recording ? "正在录制划词快捷键" : "录制划词快捷键"}
                aria-pressed={recording}
                aria-describedby="desktop-shortcut-feedback"
                disabled={!status || busy}
                onClick={() => {
                  if (recordingRef.current) void stopRecording();
                  else void beginRecording();
                }}
                onKeyDown={captureKey}
                onBlur={() => {
                  if (recordingRef.current) void stopRecording();
                }}
              >
                {recording ? (
                  <span className="desktop-recording-label">
                    <i />
                    请按下组合键
                  </span>
                ) : (
                  <Keycaps value={shortcut || "Ctrl+Shift+E"} />
                )}
              </button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  busy || recording || !status || shortcut === "Ctrl+Shift+E"
                }
                onClick={() => {
                  setShortcut("Ctrl+Shift+E");
                  setKeyError("");
                  setNotice("");
                }}
              >
                <RotateCcw size={14} />
                恢复默认
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={
                  busy ||
                  recording ||
                  !status ||
                  !shortcut ||
                  shortcut === status.preferences.shortcut
                }
                onClick={() => void save({ shortcut })}
              >
                {busy && <Loader2 className="spin" size={14} />}保存
              </Button>
            </div>
            <div
              id="desktop-shortcut-feedback"
              className="desktop-shortcut-feedback"
              aria-live="polite"
            >
              {keyError ? (
                <p className="field-error" role="alert">
                  {keyError}
                </p>
              ) : status?.shortcutError ? (
                <p className="field-error" role="alert">
                  {status.shortcutError}
                </p>
              ) : notice ? (
                <p>{notice}</p>
              ) : status && shortcut !== status.preferences.shortcut ? (
                <p>
                  当前使用：{status.preferences.shortcut}
                  ，保存后应用新的快捷键。
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>
      {status &&
        (status.preferences.enabled ||
          status.preferences.pet ||
          status.preferences.selection) &&
        !status.ownsShortcuts && (
          <p className="desktop-owner-notice">
            另一个 XiaoXi 实例正在使用桌面助手；退出该实例后会自动接管。
          </p>
        )}
      {error && <ErrorNotice message={error} />}
    </section>
  );
}
const labels = {
  siliconflow: "硅基流动",
  bailian: "阿里云百炼",
  custom: "自定义兼容接口",
};
type SpeechCall = {
  id: string;
  provider: keyof typeof labels;
  audio_seconds: number;
  status: string;
  created_at: string;
};
export function SpeechConnection() {
  const [status, setStatus] = useState<SpeechSettings>();
  const [form, setForm] = useState<SpeechSettings>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [calls, setCalls] = useState<SpeechCall[]>([]);
  const mounted = useRef(false);
  const saveLock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void api<SpeechSettings>("/settings/speech")
      .then((value) => {
        if (mounted.current) setStatus(value);
      })
      .catch((e) => {
        if (mounted.current) setError(desktopError(e));
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  const saved = status?.profiles.find((p) => p.provider === status.selected);
  const profile = form?.profiles.find((p) => p.provider === form.selected);
  const ready = Boolean(saved?.key_configured && saved.url && saved.model);
  async function configure() {
    setOpen(true);
    setLoading(true);
    setError("");
    setFields({});
    setNotice("");
    try {
      const [value, activity] = await Promise.all([
        api<SpeechSettings>("/settings/speech"),
        api<SpeechCall[]>("/speech/calls"),
      ]);
      if (mounted.current) {
        setStatus(value);
        setForm(value);
        setCalls(activity);
      }
    } catch (e) {
      if (mounted.current) setError(desktopError(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  function change(
    field: "url" | "model" | "api_key",
    value: string | undefined,
  ) {
    setError("");
    setNotice("");
    setFields((f) => ({ ...f, [field]: "" }));
    setForm(
      (s) =>
        s && {
          ...s,
          profiles: s.profiles.map((p) =>
            p.provider === s.selected ? { ...p, [field]: value } : p,
          ),
        },
    );
  }
  function close(value: boolean) {
    if (busy) return;
    setOpen(value);
    if (!value) {
      setForm(undefined);
      setFields({});
      setError("");
      setNotice("");
    }
  }
  async function save() {
    if (!form || !profile || saveLock.current) return;
    const issues: Record<string, string> = {};
    if (!profile.model.trim()) issues.model = "请填写识别模型";
    try {
      const url = new URL(profile.url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        issues.url = "请输入不含密钥和查询参数的 HTTP(S) 地址";
    } catch {
      issues.url = "请填写完整的接口地址";
    }
    setFields(issues);
    if (Object.keys(issues).length) return;
    saveLock.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await api<SpeechSettings>("/settings/speech", "PUT", {
        ...form,
        profiles: form.profiles.map((p) => ({
          ...p,
          api_key: p.api_key === "" ? "" : p.api_key?.trim() || undefined,
        })),
      });
      if (mounted.current) {
        setStatus(value);
        setForm(value);
        setNotice("语音连接已保存");
      }
    } catch (e) {
      if (mounted.current) setError(desktopError(e));
    } finally {
      saveLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <ConnectionCard
      title="语音输入"
      description="按住右 Alt 说话，松开后转成文字。"
      status={ready ? "已配置" : "未配置"}
      detail={
        error && !open
          ? "连接信息暂未加载"
          : ready
            ? `${labels[status!.selected]} · ${saved!.model}`
            : "配置云端语音识别服务"
      }
      icon={Mic}
      ready={ready}
      onConfigure={() => void configure()}
    >
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="connection-config-dialog speech-dialog">
          <DialogHeader>
            <DialogTitle>语音输入</DialogTitle>
            <DialogDescription>
              录音发送到所选语音服务，识别文字填入草稿，不自动发送。
            </DialogDescription>
          </DialogHeader>
          {loading ? (
            <p className="speech-loading" role="status">
              <Loader2 className="spin" size={16} />
              正在加载语音连接…
            </p>
          ) : form && profile ? (
            <div className="speech-form">
              <div className="form-field">
                <Label htmlFor="speech-provider">语音服务</Label>
                <SoftSelect
                  id="speech-provider"
                  label="语音服务"
                  value={form.selected}
                  disabled={busy}
                  onValueChange={(value) => {
                    setForm({
                      ...form,
                      selected: value as SpeechSettings["selected"],
                    });
                    setFields({});
                    setNotice("");
                  }}
                  options={Object.entries(labels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </div>
              <div className="form-field">
                <Label htmlFor="speech-url">接口地址</Label>
                <Input
                  id="speech-url"
                  value={profile.url}
                  disabled={busy}
                  aria-invalid={Boolean(fields.url)}
                  aria-describedby={fields.url ? "speech-url-error" : undefined}
                  onChange={(e) => change("url", e.target.value)}
                  placeholder="https://example.com/v1"
                />
                {fields.url && (
                  <p id="speech-url-error" className="field-error">
                    {fields.url}
                  </p>
                )}
              </div>
              <div className="form-field">
                <Label htmlFor="speech-model">识别模型</Label>
                <Input
                  id="speech-model"
                  value={profile.model}
                  maxLength={200}
                  disabled={busy}
                  aria-invalid={Boolean(fields.model)}
                  onChange={(e) => change("model", e.target.value)}
                />
                {fields.model && <p className="field-error">{fields.model}</p>}
              </div>
              <div className="form-field">
                <div className="speech-secret-heading">
                  <Label htmlFor="speech-key">API 密钥</Label>
                  {profile.key_configured && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        change(
                          "api_key",
                          profile.api_key === "" ? undefined : "",
                        )
                      }
                    >
                      {profile.api_key === "" && <Undo2 size={13} />}
                      {profile.api_key === "" ? "撤销清除" : "清除密钥"}
                    </Button>
                  )}
                </div>
                <Input
                  id="speech-key"
                  type="password"
                  autoComplete="new-password"
                  value={profile.api_key || ""}
                  disabled={busy}
                  placeholder={
                    profile.api_key === ""
                      ? "保存后清除已存密钥"
                      : profile.key_configured
                        ? "密钥已保存，留空保持不变"
                        : "输入语音服务 API 密钥"
                  }
                  onChange={(e) =>
                    change("api_key", e.target.value || undefined)
                  }
                />
              </div>
              {calls.length > 0 && (
                <details className="speech-activity">
                  <summary>最近语音调用</summary>
                  <div>
                    {calls.slice(0, 5).map((c) => (
                      <div key={c.id}>
                        <time>{new Date(c.created_at).toLocaleString()}</time>
                        <span>
                          {labels[c.provider]} · {c.audio_seconds.toFixed(1)} 秒
                        </span>
                        <span>
                          {(
                            {
                              completed: "完成",
                              failed: "失败",
                              started: "处理中",
                              cancelled: "已取消",
                            } as Record<string, string>
                          )[c.status] || c.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ) : null}
          {error && <ErrorNotice message={error} />}
          <DialogFooter className="speech-dialog-footer">
            <span role="status">{notice || "语音连接独立保存"}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => close(false)}
            >
              关闭
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || loading || !form}
              onClick={() => void save()}
            >
              {busy && <Loader2 className="spin" size={14} />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConnectionCard>
  );
}
