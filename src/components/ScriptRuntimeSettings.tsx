import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Code2, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ErrorNotice } from "./common";

type Runtime = Record<
  string,
  { path: string; resolved: string; available: boolean }
>;
const names: Record<string, [string, string]> = {
  python: ["Python", ".py"],
  node: ["Node.js", ".js / .mjs / .cjs"],
  powershell: ["PowerShell", ".ps1"],
  bash: ["Bash", ".sh"],
};
export function ScriptRuntimeSettings() {
  const [runtimes, setRuntimes] = useState<Runtime>({});
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<Runtime>("/skill-runtimes");
      setRuntimes(result);
      setPaths(
        Object.fromEntries(
          Object.entries(result).map(([key, item]) => [key, item.path]),
        ),
      );
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="script-runtime-page">
      <div className="skills-heading">
        <div>
          <h2>
            <Code2 size={21} />
            脚本环境
          </h2>
          <p>为技能配置解释器，查看本机的运行环境。</p>
        </div>
        <Button
          variant="outline"
          disabled={busy || dirty}
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
          重新检测
        </Button>
      </div>
      <p className="runtime-intro">
        留空时自动查找已安装的程序，也可以填写解释器的绝对路径。技能所需的依赖包需另行安装。
      </p>
      {error && <ErrorNotice message={error} />}
      <div className="runtime-page-grid">
        {Object.entries(runtimes).map(([key, info]) => (
          <article className="runtime-card" key={key}>
            <div className="runtime-row-heading">
              <h3>
                {names[key]?.[0] || key}
                <small>{names[key]?.[1]}</small>
              </h3>
              <span
                className={`runtime-status ${info.available ? "available" : ""}`}
              >
                {info.available && <CheckCircle2 size={13} />}
                {info.available ? "已找到" : "未找到"}
              </span>
            </div>
            <Label htmlFor={`runtime-${key}`}>
              {names[key]?.[0] || key} 解释器路径
            </Label>
            <Input
              id={`runtime-${key}`}
              value={paths[key] || ""}
              disabled={busy}
              placeholder="自动检测，或填写程序的绝对路径"
              onChange={(event) => {
                setPaths({ ...paths, [key]: event.target.value });
                setDirty(true);
                setNotice("");
              }}
            />
            <p className="runtime-resolved">
              {info.resolved
                ? `当前检测：${info.resolved}`
                : "尚未找到程序，请安装后重新检测，或手动指定路径。"}
            </p>
          </article>
        ))}
      </div>
      <div className="runtime-page-actions">
        <span role="status">{notice || (dirty ? "有尚未保存的修改" : "")}</span>
        <Button
          disabled={busy || !dirty}
          onClick={async () => {
            setBusy(true);
            setError("");
            setNotice("");
            try {
              setRuntimes(await api<Runtime>("/skill-runtimes", "PUT", paths));
              setDirty(false);
              setNotice("运行环境已保存");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={14} className="spin" />}保存运行环境
        </Button>
      </div>
      <p className="runtime-intro">
        运行环境供已授权的技能脚本使用；每个技能的脚本权限仍在「技能」中单独设置。
      </p>
    </section>
  );
}
