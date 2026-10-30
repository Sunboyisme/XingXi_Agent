import { useCallback, useEffect, useRef, useState } from "react";
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
import { BaiAvatar } from "./BaiAvatar";
import { SelectionSettings } from "./SelectionSettings";
import { pomodoroThemes, readPomodoroTheme } from "@/lib/pomodoroAppearance";
import "../styles/desktop-settings.css";
type DesktopStatus = {
  preferences: DesktopPreferences;
  ownsShortcuts: boolean;
  selectionShortcutError?: string;
};
export function DesktopSettings() {
  const [status, setStatus] = useState<DesktopStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [petSize, setPetSize] = useState("100");
  const [petSizeError, setPetSizeError] = useState("");
  const [petNotice, setPetNotice] = useState("");
  const mounted = useRef(false);
  const saving = useRef(false);
  const sizeFocused = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!isTauri()) return;
    const accept = (value: DesktopStatus) => {
      if (!mounted.current) return;
      setStatus(value);
      if (!sizeFocused.current) setPetSize(String(value.preferences.petSize));
    };
    const listener = desktopListen<DesktopStatus>(
      "desktop-preferences",
      accept,
    );
    void listener
      .then(() => invoke<DesktopStatus>("desktop_preferences"))
      .then(accept)
      .catch((e) => {
        if (mounted.current) setError(desktopError(e));
      });
    return () => {
      mounted.current = false;
      void listener.then((f) => f());
    };
  }, []);
  async function save(change: Partial<DesktopPreferences>) {
    if (saving.current || !status) return false;
    saving.current = true;
    setBusy(true);
    setError("");
    setPetNotice("");
    try {
      const value = await invoke<DesktopStatus>("desktop_preferences_save", {
        preferences: change,
      });
      if (mounted.current) {
        setStatus(value);
        if (change.petSize !== undefined)
          setPetSize(String(value.preferences.petSize));
      }
      return true;
    } catch (e) {
      if (mounted.current) setError(desktopError(e));
      return false;
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function savePetSize() {
    sizeFocused.current = false;
    const value = Number(petSize);
    if (
      !petSize.trim() ||
      !Number.isInteger(value) ||
      value < 50 ||
      value > 200
    ) {
      setPetSizeError("请输入 50% 到 200% 之间的整数");
      return;
    }
    setPetSizeError("");
    if (value !== status?.preferences.petSize) void save({ petSize: value });
  }
  async function resetPet() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setPetNotice("");
    try {
      const value = await invoke<DesktopStatus>("desktop_pet_reset");
      if (mounted.current) {
        setStatus(value);
        setPetNotice("已返回鼠标所在屏幕的右侧默认位置");
      }
    } catch (e) {
      if (mounted.current) setError(desktopError(e));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function featureRow(
    key: "enabled" | "pet" | "pomodoro",
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
          {key === "enabled" && (
            <span className="desktop-keycaps">
              <kbd>右 Alt</kbd>
            </span>
          )}
          <label className="module-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-label={label}
              disabled={!status || busy}
              checked={status?.preferences[key] || false}
              onChange={(e) => void save({ [key]: e.target.checked })}
            />
            <span>{status?.preferences[key] ? "已开启" : "已关闭"}</span>
          </label>
        </div>
      </div>
    );
  }
  if (!isTauri())
    return <p>桌面截图问答、划词助手、桌宠和桌面番茄钟仅在桌面版中可用。</p>;
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
        </div>
      </section>
      {status && (
        <SelectionSettings
          enabled={status.preferences.selectionEnabled}
          shortcut={status.preferences.selectionShortcut}
          ownsShortcuts={status.ownsShortcuts}
          shortcutError={status.selectionShortcutError || ""}
          busy={busy}
          save={save}
        />
      )}
      <section className="settings-group">
        <h2>桌面番茄钟</h2>
        <div className="desktop-preference-card">
          {featureRow(
            "pomodoro",
            "显示桌面番茄钟",
            "无需开启桌宠。专注时自动显示，也可从番茄钟页面或系统托盘打开；收起后继续计时。",
          )}
          <div className="desktop-feature-row">
            <div className="desktop-feature-copy">
              <strong>主题颜色</strong>
              <p>单独设置桌面番茄钟的配色。</p>
            </div>
            <SoftSelect
              className="desktop-pomodoro-theme"
              label="桌面番茄钟主题颜色"
              value={readPomodoroTheme(status?.preferences.pomodoroTheme)}
              disabled={!status || busy}
              options={[...pomodoroThemes]}
              onValueChange={(value) => void save({ pomodoroTheme: readPomodoroTheme(value) })}
            />
          </div>
        </div>
      </section>
      <section className="settings-group">
        <h2>桌面宠物</h2>
        <div className="desktop-preference-card">
          <div className="desktop-feature-row">
            <div className="desktop-feature-copy">
              <strong>当前桌宠</strong>
              <p>XiaoXi</p>
            </div>
            <div className="desktop-pet-preview">
              <BaiAvatar />
            </div>
          </div>
          {featureRow(
            "pet",
            "显示桌面宠物",
            "拖动调整位置，轻触打开番茄钟，双击打开主窗口。桌面番茄钟可独立使用。",
          )}
          <div className="desktop-feature-row">
            <div className="desktop-feature-copy">
              <strong>桌宠大小</strong>
              <p>调整桌面宠物显示大小，支持 50%–200%。</p>
            </div>
            <div className="desktop-pet-size-control">
              <div className="desktop-pet-size-input">
                <Input
                  aria-label="桌宠大小百分比"
                  type="number"
                  min={50}
                  max={200}
                  step={5}
                  value={petSize}
                  disabled={!status || busy}
                  aria-invalid={Boolean(petSizeError)}
                  aria-describedby={
                    petSizeError ? "desktop-pet-size-error" : undefined
                  }
                  onFocus={() => {
                    sizeFocused.current = true;
                  }}
                  onChange={(e) => {
                    setPetSize(e.target.value);
                    setPetSizeError("");
                  }}
                  onBlur={savePetSize}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                />
                <span>%</span>
              </div>
              {petSizeError && (
                <p id="desktop-pet-size-error" className="field-error">
                  {petSizeError}
                </p>
              )}
            </div>
          </div>
          <div className="desktop-feature-row">
            <div className="desktop-feature-copy">
              <strong>重置位置</strong>
              <p>将当前桌宠移至鼠标所在屏幕的右侧默认位置。</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!status || busy}
              onClick={() => void resetPet()}
            >
              <RotateCcw size={14} />
              重置
            </Button>
          </div>
        </div>
        {petNotice && (
          <p className="desktop-pet-feedback" role="status">
            {petNotice}
          </p>
        )}
      </section>
      {status &&
        (status.preferences.enabled || status.preferences.pet) &&
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
export function SpeechConnection({
  configureRequested = false,
  onConfigureHandled,
}: {
  configureRequested?: boolean;
  onConfigureHandled?: () => void;
}) {
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
  const requestHandled = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void api<SpeechSettings>("/settings/speech")
      .then((value) => {
        if (!value || !Array.isArray(value.profiles)) throw new Error("语音配置返回异常，请重新打开配置。");
        if (mounted.current) setStatus(value);
      })
      .catch((e) => {
        if (mounted.current) setError(desktopError(e));
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  const saved = status?.profiles?.find((p) => p.provider === status.selected);
  const profile = form?.profiles?.find((p) => p.provider === form.selected);
  const ready = Boolean(saved?.key_configured && saved.url && saved.model);
  const configure = useCallback(async () => {
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
      if (!value || !Array.isArray(value.profiles) || !Array.isArray(activity)) throw new Error("语音配置返回异常，请稍后重试。");
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
  }, []);
  useEffect(() => {
    if (!configureRequested) {
      requestHandled.current = false;
      return;
    }
    if (requestHandled.current) return;
    requestHandled.current = true;
    void configure();
    onConfigureHandled?.();
  }, [configureRequested, onConfigureHandled, configure]);
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
