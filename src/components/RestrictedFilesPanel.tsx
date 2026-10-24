import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { api } from "@/lib/api";
import { type FileSession, type FileSaveRequest } from "@/lib/restrictedFiles";
import { Button } from "./ui/button";
import { FileCard } from "./OfficeFiles";
import "@/styles/restricted-files.css";

const states: Record<string, string> = {
  pending: "等待授权",
  active: "已授权",
  stopped: "已停止",
  expired: "授权已过期",
  ready: "等待确认保存",
  saved: "已保存",
  cancelled: "已取消",
  failed: "保存失败",
  unknown: "结果待核实",
  saving: "保存中",
};
const actions: Record<string, string> = {
  authorized: "授权读取",
  read: "读取文件",
  stopped: "停止任务",
  save_requested: "申请保存",
  saved: "保存成功",
  failed: "保存失败",
  unknown: "结果待核实",
  save_cancelled: "取消保存",
};

export function RestrictedFilesPanel({
  conversationId,
  modelSelection,
  modelLabel,
  modelUrl,
  running,
}: {
  conversationId: string;
  modelSelection: {
    provider_id: string;
    model_name: string;
    thinking_enabled: boolean;
  } | null;
  modelLabel: string;
  modelUrl: string;
  running: boolean;
}) {
  const [session, setSession] = useState<FileSession | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [recursive, setRecursive] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const refresh = useCallback(async () => {
    const next = await api<FileSession>(`/file-sessions/${conversationId}`);
    setSession(next);
  }, [conversationId]);
  useEffect(() => {
    let live = true;
    const update = () => {
      if (live)
        void refresh().catch((e: Error) => {
          if (live) setError(e.message);
        });
    };
    update();
    const timer = window.setInterval(update, 2500);
    window.addEventListener("xiaoxi-file-session-updated", update);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("xiaoxi-file-session-updated", update);
    };
  }, [refresh]);
  async function act(operation: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function select(folder: boolean) {
    if (!isTauri()) throw new Error("请在桌面版中选择本机资料");
    const selected = await invoke<string[]>("pick_restricted_files", {
      folder,
    });
    if (selected.length) {
      setPaths((old) => [...new Set([...old, ...selected])].slice(0, 20));
      setEditing(true);
    }
  }
  async function selectTarget(request: FileSaveRequest) {
    if (!isTauri()) throw new Error("请在桌面版中选择保存位置");
    const target = await invoke<string | null>("pick_restricted_save_target", {
      name: request.name,
    });
    if (target)
      await api(`/file-save-requests/${request.id}/target`, "POST", { target });
  }
  const changedModel = Boolean(
    session?.model_binding.model_name &&
    (session.model_binding.model_name !== modelSelection?.model_name ||
      session.model_binding.provider_id !== modelSelection?.provider_id ||
      session.model_binding.model_url !== modelUrl),
  );
  return (
    <section className="restricted-files-panel" aria-label="受限文件任务">
      <div className="restricted-files-heading">
        <strong>受限文件任务</strong>
        <span>{states[session?.status || "pending"]}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || session?.status !== "active"}
          onClick={() =>
            void act(() => api(`/file-sessions/${conversationId}/stop`, "POST"))
          }
        >
          停止并撤销授权
        </Button>
      </div>
      <p>
        仅读取授权资料、生成新文件。不会覆盖或删除原件，不访问网页、不执行脚本。
      </p>
      <p>
        内容将发送给模型：<strong>{modelLabel || "尚未选择模型"}</strong> ·{" "}
        {modelUrl || "请先配置连接"}
      </p>
      {changedModel && (
        <p role="alert">模型连接已变化，请重新确认资料发送的目标。</p>
      )}
      {session?.status === "active" && (
        <p>
          有效至 {new Date(session.expires_at).toLocaleTimeString()} · 已读取{" "}
          {session.read_count}/20 个文件
        </p>
      )}
      {!!session?.grants.length && (
        <details>
          <summary>查看当前授权范围（{session.grants.length} 项）</summary>
          <ul>
            {session.grants.map((g) => (
              <li key={g.path}>
                <code>{g.path}</code> ·{" "}
                {g.recursive ? "含子目录" : "不含子目录"}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="restricted-files-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || running}
          onClick={() => void act(() => select(false))}
        >
          选择文件
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || running}
          onClick={() => void act(() => select(true))}
        >
          选择文件夹
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || running}
          onClick={() => {
            setPaths(session?.grants.map((g) => g.path) || []);
            setRecursive(false);
            setEditing(true);
          }}
        >
          调整或重新授权
        </Button>
      </div>
      {(editing || session?.status !== "active" || changedModel) && (
        <div className="restricted-file-grant">
          <p>
            确认后允许当前模型读取下列资料及本会话已有内容，授权最长两小时。未选资料时仅允许生成新文件。
          </p>
          <ul>
            {paths.map((path) => (
              <li key={path}>
                <code>{path}</code>
                <button
                  aria-label={`移除 ${path}`}
                  onClick={() => setPaths(paths.filter((p) => p !== path))}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
          <label>
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
            />
            允许读取所选文件夹的子目录
          </label>
          <Button
            size="sm"
            disabled={busy || running || !modelSelection}
            onClick={() =>
              void act(async () => {
                await api(
                  `/file-sessions/${conversationId}/authorize`,
                  "POST",
                  { paths, recursive, model_selection: modelSelection },
                );
                setEditing(false);
              })
            }
          >
            确认授权给当前模型
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="restricted-files-error">
          {error}
        </p>
      )}
      {!!session?.saves.length && (
        <details open>
          <summary>保存申请（{session.saves.length}）</summary>
          {session.saves.map((request) => (
            <div className="restricted-save-card" key={request.id}>
              <strong>{request.name}</strong>
              <span>
                {["pending", "ready"].includes(request.status) &&
                new Date(request.expires_at).getTime() <= Date.now()
                  ? "申请已过期，请重新申请"
                  : request.status === "pending"
                    ? "等待选择保存位置"
                    : states[request.status]}{" "}
                · {(request.size / 1024).toFixed(1)} KB
              </span>
              <FileCard
                file={{ id: request.artifact_id, name: request.name }}
                compact
                previewOnly
              />
              {request.target && (
                <p>
                  完整路径：<code>{request.target}</code>
                </p>
              )}
              {request.error && <p role="alert">{request.error}</p>}
              {["pending", "ready"].includes(request.status) && (
                <div className="restricted-files-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void act(() => selectTarget(request))}
                  >
                    选择保存位置
                  </Button>
                  {request.status === "ready" && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void act(() =>
                          api(
                            `/file-save-requests/${request.id}/confirm`,
                            "POST",
                            { target: request.target, digest: request.digest },
                          ),
                        )
                      }
                    >
                      确认新建文件
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api(`/file-save-requests/${request.id}/cancel`, "POST"),
                      )
                    }
                  >
                    取消
                  </Button>
                </div>
              )}
            </div>
          ))}
        </details>
      )}
      {!!session?.events.length && (
        <details>
          <summary>操作记录</summary>
          <ul>
            {session.events.map((event, i) => (
              <li key={`${event.created_at}-${i}`}>
                {new Date(event.created_at).toLocaleTimeString()} ·{" "}
                {actions[event.action] || event.action}{" "}
                {String(event.detail.path || "")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
