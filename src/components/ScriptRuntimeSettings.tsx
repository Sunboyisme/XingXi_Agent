import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { CheckCircle2, CircleDashed, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import {
  emptyRuntimeEditor,
  type Runtime,
  type RuntimeEditorState,
} from "@/lib/runtimeEditor";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ErrorNotice, Hint } from "./common";
import { errorMessage } from "@/lib/utils";
import "../styles/script-runtime-settings.css";

const names: Record<string, [string, string]> = {
  python: ["Python", ".py"],
  node: ["Node.js", ".js / .mjs / .cjs"],
  powershell: ["PowerShell", ".ps1"],
  bash: ["Bash", ".sh"],
};

export function ScriptRuntimeSettings({
  editor,
  onEditorChange,
}: {
  editor?: RuntimeEditorState;
  onEditorChange?: Dispatch<SetStateAction<RuntimeEditorState>>;
}) {
  const [localEditor, setLocalEditor] = useState(emptyRuntimeEditor);
  const { runtimes, paths, busy, dirty, error, notice, loaded } =
    editor || localEditor;
  const update = onEditorChange || setLocalEditor;
  const operation = useRef(false);
  const load = useCallback(async () => {
    if (operation.current) return;
    operation.current = true;
    update((state) => ({ ...state, busy: true, error: "" }));
    try {
      const result = await api<Runtime>("/skill-runtimes");
      update((state) => ({
        ...state,
        runtimes: result,
        loaded: true,
        paths: state.dirty
          ? state.paths
          : Object.fromEntries(
              Object.entries(result).map(([key, item]) => [key, item.path]),
            ),
      }));
    } catch (e) {
      update((state) => ({ ...state, error: errorMessage(e) }));
    } finally {
      operation.current = false;
      update((state) => ({ ...state, busy: false }));
    }
  }, [update]);
  useEffect(() => {
    if (!loaded && !busy && !error) void load();
  }, [load, loaded, busy, error]);
  async function save() {
    if (busy || !dirty || operation.current) return;
    operation.current = true;
    update((state) => ({ ...state, busy: true, error: "", notice: "" }));
    try {
      const result = await api<Runtime>("/skill-runtimes", "PUT", paths);
      update((state) => ({
        ...state,
        runtimes: result,
        dirty: false,
        notice: "运行环境已保存",
      }));
    } catch (e) {
      update((state) => ({ ...state, error: errorMessage(e) }));
    } finally {
      operation.current = false;
      update((state) => ({ ...state, busy: false }));
    }
  }
  return (
    <section className="script-runtime-page" aria-label="脚本运行环境">
      <div className="runtime-toolbar">
        <p>为技能设置本机解释器。路径留空时自动检测，修改后保存生效。</p>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || dirty}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          重新检测
        </Button>
      </div>
      {error && <ErrorNotice message={error} />}
      {busy && !Object.keys(runtimes).length && (
        <p className="runtime-loading" role="status">
          正在读取运行环境…
        </p>
      )}
      <div className="runtime-list">
        <div className="runtime-list-heading" aria-hidden="true">
          <span>运行环境</span>
          <span>解释器路径</span>
          <span>检测状态</span>
        </div>
        {Object.entries(runtimes).map(([key, info]) => (
          <article
            className="runtime-row"
            key={key}
            aria-label={names[key]?.[0] || key}
          >
            <div className="runtime-name">
              <h2>{names[key]?.[0] || key}</h2>
              <small>{names[key]?.[1]}</small>
            </div>
            <div className="runtime-path">
              <Label className="sr-only" htmlFor={`runtime-${key}`}>
                {names[key]?.[0] || key} 解释器路径
              </Label>
              <Input
                id={`runtime-${key}`}
                value={paths[key] || ""}
                disabled={busy}
                placeholder="自动检测，或填写程序的绝对路径"
                onChange={(event) => {
                  const value = event.target.value;
                  update((state) => ({
                    ...state,
                    paths: { ...state.paths, [key]: value },
                    dirty: true,
                    notice: "",
                  }));
                }}
              />
              {info.resolved ? (
                <Hint
                  label={
                    <>
                      <span>当前检测 · {names[key]?.[0] || key}</span>
                      <span>{info.resolved}</span>
                    </>
                  }
                >
                  <span className="runtime-resolved" tabIndex={0}>
                    {info.resolved}
                  </span>
                </Hint>
              ) : (
                <p className="runtime-unresolved">
                  未检测到程序，请安装后重新检测，或指定路径。
                </p>
              )}
            </div>
            <span
              className={`runtime-status ${info.available ? "available" : ""}`}
            >
              {info.available ? (
                <CheckCircle2 size={13} aria-hidden="true" />
              ) : (
                <CircleDashed size={13} aria-hidden="true" />
              )}
              {info.available ? "已找到" : "未找到"}
            </span>
          </article>
        ))}
      </div>
      <div className="runtime-footer">
        <p>依赖包需另行安装，脚本权限在「技能」中单独设置。</p>
        <div className="runtime-save-actions">
          <span role="status">
            {notice || (dirty ? "有尚未保存的修改" : "")}
          </span>
          <Button
            size="sm"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {busy && <Loader2 size={14} className="spin" />}保存运行环境
          </Button>
        </div>
      </div>
    </section>
  );
}
