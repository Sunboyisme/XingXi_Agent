import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  api,
  invoke,
  desktopError,
  type DesktopPreferences,
  type SpeechSettings,
} from "@/lib/desktopAssistant";
import { ErrorNotice } from "./common";

export function DesktopSettings() {
  const [prefs, setPrefs] = useState<DesktopPreferences>();
  const [owned, setOwned] = useState(false);
  const [shortcut, setShortcut] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isTauri())
      void invoke<{ preferences: DesktopPreferences; ownsShortcuts: boolean }>(
        "desktop_preferences",
      )
        .then((v) => {
          setPrefs(v.preferences);
          setShortcut(v.preferences.shortcut);
          setOwned(v.ownsShortcuts);
        })
        .catch((e) => setError(desktopError(e)));
  }, []);
  async function save(change: Partial<DesktopPreferences>) {
    if (!prefs) return;
    setBusy(true);
    setError("");
    try {
      const next = { ...prefs, ...change };
      await invoke("desktop_preferences_save", { preferences: next });
      setPrefs(next);
    } catch (e) {
      setError(desktopError(e));
    } finally {
      setBusy(false);
    }
  }
  if (!isTauri()) return <p>截图问答、桌宠和系统划词仅在桌面版中可用。</p>;
  return (
    <section className="desktop-preferences">
      {(
        [
          ["enabled", "桌面截图问答", "短按右 Alt 唤出；按住右 Alt 语音输入。"],
          ["pet", "桌面 XiaoXi", "视线跟随、点击问答，以及任务和提醒气泡。"],
          ["selection", "手动划词助手", "选中文字后使用划词快捷键。"],
        ] as const
      ).map(([key, label, detail]) => (
        <div className="general-setting-row" key={key}>
          <div>
            <strong>{label}</strong>
            <p>{detail}</p>
          </div>
          <label className="module-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-label={label}
              disabled={!prefs || busy}
              checked={prefs?.[key] || false}
              onChange={(e) => void save({ [key]: e.target.checked })}
            />
            <span>{prefs?.[key] ? "已开启" : "已关闭"}</span>
          </label>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save({ shortcut });
        }}
        noValidate
        className="desktop-shortcut"
      >
        <label>
          划词快捷键
          <input
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value)}
            placeholder="Ctrl+Shift+E"
          />
        </label>
        <button disabled={busy || !prefs} type="submit">
          保存快捷键
        </button>
      </form>
      {prefs?.enabled && !owned && (
        <p>快捷键目前由另一个 XiaoXi 实例持有；该实例退出后会自动接管。</p>
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
export function SpeechConnection() {
  const [settings, setSettings] = useState<SpeechSettings>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [calls, setCalls] = useState<
    {
      id: string;
      provider: keyof typeof labels;
      audio_seconds: number;
      status: string;
      created_at: string;
    }[]
  >([]);
  useEffect(() => {
    void Promise.all([
      api<SpeechSettings>("/settings/speech"),
      api<typeof calls>("/speech/calls"),
    ])
      .then(([s, c]) => {
        setSettings(s);
        setCalls(c);
      })
      .catch((e) => setError(desktopError(e)));
  }, []);
  const profile = settings?.profiles.find(
    (p) => p.provider === settings.selected,
  );
  function change(field: string, value: string) {
    setSaved(false);
    setSettings(
      (s) =>
        s && {
          ...s,
          profiles: s.profiles.map((p) =>
            p.provider === s.selected ? { ...p, [field]: value } : p,
          ),
        },
    );
  }
  async function save() {
    if (!settings) return;
    setBusy(true);
    setError("");
    try {
      setSettings(
        await api<SpeechSettings>("/settings/speech", "PUT", settings),
      );
      setSaved(true);
    } catch (e) {
      setError(desktopError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="speech-connection">
      <h3>语音输入</h3>
      <p>
        按住右 Alt
        录音，松开后转为文字。录音会发送到选定服务，不在本机永久保存。
      </p>
      {settings && profile && (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            语音服务
            <select
              value={settings.selected}
              onChange={(e) => {
                setSettings({
                  ...settings,
                  selected: e.target.value as SpeechSettings["selected"],
                });
                setSaved(false);
              }}
            >
              {Object.entries(labels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            接口地址
            <input
              value={profile.url}
              onChange={(e) => change("url", e.target.value)}
            />
          </label>
          <label>
            识别模型
            <input
              value={profile.model}
              onChange={(e) => change("model", e.target.value)}
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="off"
              value={profile.api_key ?? ""}
              placeholder={
                profile.key_configured ? "已配置；留空保留" : "填写语音服务密钥"
              }
              onChange={(e) => change("api_key", e.target.value)}
            />
          </label>
          <div className="speech-save">
            <button disabled={busy} type="submit">
              {busy ? "保存中…" : "保存语音连接"}
            </button>
            {profile.key_configured && (
              <button
                disabled={busy}
                type="button"
                onClick={() => change("api_key", "")}
              >
                清除密钥
              </button>
            )}
            {saved && <span role="status">已保存</span>}
          </div>
        </form>
      )}
      {calls.length > 0 && (
        <details>
          <summary>最近语音调用</summary>
          {calls.slice(0, 5).map((c) => (
            <p key={c.id}>
              {new Date(c.created_at).toLocaleString()} · {labels[c.provider]} ·{" "}
              {c.audio_seconds.toFixed(1)} 秒 ·{" "}
              {(
                {
                  completed: "完成",
                  failed: "失败",
                  started: "处理中",
                  cancelled: "已取消",
                } as Record<string, string>
              )[c.status] || c.status}
            </p>
          ))}
        </details>
      )}
      {error && <ErrorNotice message={error} />}
    </section>
  );
}
