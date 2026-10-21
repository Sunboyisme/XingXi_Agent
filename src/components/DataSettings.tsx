import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Database, Download, FolderOpen, Upload } from "lucide-react";
import { api, fetchApi } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ErrorNotice } from "./common";

type Data = components["schemas"]["DataRead"];
type Preview = components["schemas"]["DataImportRead"];
type Exported = components["schemas"]["DataExportRead"];
const labels: Record<string, string> = {
  conversations: "对话",
  messages: "消息",
  memories: "记忆",
  memory_vectors: "向量",
  reminders: "提醒时间",
  calendar_events: "计划",
  plan_occurrences: "单次状态记录",
  plan_segments: "重复规则调整",
  artifacts: "工具产物",
  complex_tasks: "复杂任务",
  goals: "学习目标",
  attachments: "图片",
};

export function DataSettings() {
  const [data, setData] = useState<Data>();
  const [preview, setPreview] = useState<Preview>();
  const [fileName, setFileName] = useState("");
  const [exported, setExported] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    api<Data>("/settings/data")
      .then((value) => {
        if (live) setData(value);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  async function perform(action: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function exportData() {
    setExported("");
    if (isTauri()) {
      const path = await invoke<string | null>("save_data_export");
      if (path) setExported(path);
      return;
    }
    const value = await api<Exported>("/settings/data/export", "POST");
    setExported(value.name);
    if (!isTauri()) {
      const response = await fetchApi(
        `/settings/data/exports/${encodeURIComponent(value.name)}`,
      );
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = value.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  async function inspect(selected: File) {
    setPreview(undefined);
    if (selected.size > 512 * 1024 * 1024)
      throw new Error("数据文件不能超过 512 MB");
    const body = new FormData();
    body.append("file", selected);
    const response = await fetchApi("/settings/data/inspect", {
      method: "POST",
      body,
    });
    setFileName(selected.name);
    setPreview(await response.json());
  }
  return (
    <div className="data-settings">
      {error && <ErrorNotice message={error} />}
      <section className="data-card">
        <div className="data-card-heading">
          <span>
            <Database size={18} />
          </span>
          <div>
            <h2>本机数据</h2>
            <p>SQLite · 记忆原文与向量保存在同一个数据库</p>
          </div>
        </div>
        {!data ? (
          <p className="retrieval-empty">正在读取数据位置…</p>
        ) : (
          <>
            <div className="data-counts">
              {Object.entries(data.counts).map(([name, count]) => (
                <div key={name}>
                  <strong>{count}</strong>
                  <span>{labels[name] || name}</span>
                </div>
              ))}
            </div>
            <dl className="data-paths">
              <div>
                <dt>数据目录</dt>
                <dd>{data.directory}</dd>
              </div>
              <div>
                <dt>数据库</dt>
                <dd>{data.database}</dd>
              </div>
              <div>
                <dt>图片附件</dt>
                <dd>{data.attachments}</dd>
              </div>
            </dl>
            {isTauri() && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void perform(() => invoke("open_data_directory"))
                }
              >
                <FolderOpen size={15} />
                打开数据目录
              </Button>
            )}
          </>
        )}
      </section>
      <section className="data-card">
        <div className="data-card-heading">
          <span>
            <Download size={18} />
          </span>
          <div>
            <h2>导入与导出</h2>
            <p>聊天、思考、记忆、向量、图片、学习进度与计划</p>
          </div>
        </div>
        <p className="data-transfer-note">
          ZIP
          文件包含个人内容、日程和工具产物，请妥善保管。连接配置、技能与执行授权、API
          密钥和微信绑定不导出。
        </p>
        <div className="data-transfer-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={!data || busy}
            onClick={() => void perform(exportData)}
          >
            <Download size={15} />
            {busy ? "处理中…" : "导出数据"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || busy || data.pending}
            onClick={() => file.current?.click()}
          >
            <Upload size={15} />
            导入数据
          </Button>
          <input
            ref={file}
            type="file"
            accept=".zip,application/zip"
            aria-label="选择 XiaoXi 数据文件"
            hidden
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = "";
              if (selected) void perform(() => inspect(selected));
            }}
          />
        </div>
        {exported && (
          <p className="data-result" role="status">
            已导出到 <span>{exported}</span>
          </p>
        )}
        {data?.pending && (
          <div className="data-pending" role="status">
            <p>
              数据已准备好，完全退出并重新启动后恢复。恢复前会自动备份当前数据。
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api("/settings/data/import", "DELETE");
                  setData(await api<Data>("/settings/data"));
                })
              }
            >
              取消待导入
            </Button>
          </div>
        )}
        {data?.last_import && (
          <p className="data-result" role="status">
            {data.last_import.ok
              ? `上次导入完成。原数据备份：${data.last_import.backup}`
              : String(data.last_import.error)}
          </p>
        )}
      </section>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open && !busy) setPreview(undefined);
        }}
      >
        <DialogContent className="data-import-dialog">
          <DialogHeader>
            <DialogTitle>导入数据</DialogTitle>
            <DialogDescription>{fileName}</DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <p className="data-transfer-note">
                将替换当前聊天、记忆、图片、学习和计划；本机连接与密钥保留。重启时先自动备份，再恢复。
              </p>
              <div className="data-counts">
                {Object.entries(preview.counts).map(([name, count]) => (
                  <div key={name}>
                    <strong>{count}</strong>
                    <span>{labels[name] || name}</span>
                  </div>
                ))}
              </div>
              <p className="data-transfer-note">
                导出时间：{new Date(preview.created_at).toLocaleString("zh-CN")}
              </p>
              {error && <ErrorNotice message={error} />}
              <div className="dialog-actions">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setPreview(undefined)}
                >
                  取消
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api("/settings/data/import", "POST", {
                        id: preview.id,
                      });
                      setData(await api<Data>("/settings/data"));
                      setPreview(undefined);
                    })
                  }
                >
                  {busy ? "处理中…" : "确认导入，重启后恢复"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
