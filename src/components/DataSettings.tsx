import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Database, Download, FolderOpen, Upload } from "lucide-react";
import { api, downloadApiFile, fetchApi } from "@/lib/api";
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
import { errorMessage } from "@/lib/utils";

type Data = components["schemas"]["DataRead"];
type Preview = components["schemas"]["DataImportRead"];
type Exported = components["schemas"]["DataExportRead"];
// Category totals count stored records, including each category's related records.
const countGroups = [
  {
    title: "对话",
    keys: [
      "conversations",
      "messages",
      "attachments",
      "office_files",
      "artifacts",
      "complex_tasks",
    ],
  },
  {
    title: "项目",
    keys: ["projects", "project_materials"],
  },
  {
    title: "学习",
    keys: [
      "goals",
      "learning_intakes",
      "learning_sessions",
      "learning_reviews",
    ],
  },
  {
    title: "计划与提醒",
    keys: [
      "calendar_events",
      "todos",
      "reminders",
      "plan_occurrences",
      "plan_segments",
      "plan_day_orders",
    ],
  },
  {
    title: "记忆与知识库",
    keys: [
      "memories",
      "memory_vectors",
      "knowledge_documents",
      "knowledge_chunks",
      "knowledge_vectors",
    ],
  },
  {
    title: "模型用量",
    keys: ["usage_calls", "usage_prices"],
  },
];
const knownCountKeys = new Set(countGroups.flatMap((group) => group.keys));

function DataCounts({ counts }: { counts: Record<string, number> }) {
  const others = Object.keys(counts).filter((key) => !knownCountKeys.has(key));
  const groups = others.length
    ? [...countGroups, { title: "其他", keys: others }]
    : countGroups;
  return (
    <dl className="data-counts" aria-label="分类记录总数">
      {groups.map((group) => {
        const keys = group.keys.filter((key) => key in counts);
        if (!keys.length) return null;
        return (
          <div key={group.title}>
            <dt>{group.title}</dt>
            <dd>
              {keys
                .reduce((total, key) => total + counts[key], 0)
                .toLocaleString("zh-CN")}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

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
      .catch((e) => {
        if (live) setError(errorMessage(e));
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
      setError(errorMessage(e));
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
      await downloadApiFile(
        `/settings/data/exports/${encodeURIComponent(value.name)}`,
        value.name,
      );
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
            <p>使用 SQLite 存储 · 各类记录合计（含关联记录）</p>
          </div>
        </div>
        {!data ? (
          <p className="retrieval-empty">正在读取数据位置…</p>
        ) : (
          <>
            <DataCounts counts={data.counts} />
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
              <DataCounts counts={preview.counts} />
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
