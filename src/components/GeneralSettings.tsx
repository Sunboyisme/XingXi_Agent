import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Power } from "lucide-react";
import { ErrorNotice } from "./common";

type Autostart = { enabled: boolean; supported: boolean; reason: string };
export function GeneralSettings() {
  const [value, setValue] = useState<Autostart>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    if (!isTauri()) {
      setValue({
        enabled: false,
        supported: false,
        reason: "开机自启仅在桌面安装版中设置。",
      });
      return;
    }
    void invoke<Autostart>("get_autostart")
      .then((result) => {
        if (live) setValue(result);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="general-settings">
      <header>
        <Power size={20} />
        <div>
          <h2>启动</h2>
          <p>设置 XiaoXi 的启动方式。</p>
        </div>
      </header>
      <div className="general-setting-row">
        <div>
          <strong>开机自启</strong>
          <p>{value?.reason || "登录 Windows 后自动打开 XiaoXi。"}</p>
        </div>
        <label className="module-toggle">
          <input
            type="checkbox"
            role="switch"
            aria-label="开机自启"
            checked={value?.enabled || false}
            disabled={!value?.supported || busy}
            onChange={(event) => {
              const enabled = event.target.checked;
              setBusy(true);
              setError("");
              void invoke<Autostart>("set_autostart", { enabled })
                .then(setValue)
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          />
          <span>
            {busy ? "正在更新…" : value?.enabled ? "已开启" : "已关闭"}
          </span>
        </label>
      </div>
      {error && <ErrorNotice message={error} />}
    </section>
  );
}
