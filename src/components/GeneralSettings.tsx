import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  setGeneralPreferences,
  useGeneralPreferences,
} from "@/lib/generalPreferences";
import { ErrorNotice } from "./common";
import { errorMessage } from "@/lib/utils";

type Autostart = { enabled: boolean; supported: boolean; reason: string };
export function GeneralSettings() {
  const preferences = useGeneralPreferences();
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
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="general-settings">
      <div className="general-setting-row">
        <div>
          <strong>开机自启</strong>
          <p>
            {value?.reason ||
              "登录 Windows 后在系统托盘运行，双击托盘图标打开窗口。"}
          </p>
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
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          />
          <span>
            {busy ? "正在更新…" : value?.enabled ? "已开启" : "已关闭"}
          </span>
        </label>
      </div>
      <div className="general-setting-row">
        <div>
          <strong>聊天输入建议</strong>
          <p>根据最近的对话生成输入提示，会使用默认模型并计入用量。</p>
        </div>
        <label className="module-toggle">
          <input
            type="checkbox"
            role="switch"
            aria-label="聊天输入建议"
            checked={preferences.inputSuggestions}
            onChange={(event) =>
              setGeneralPreferences({ inputSuggestions: event.target.checked })
            }
          />
          <span>{preferences.inputSuggestions ? "已开启" : "已关闭"}</span>
        </label>
      </div>
      {error && <ErrorNotice message={error} />}
    </section>
  );
}
