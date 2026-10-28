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
// Record counts grouped by what they belong to; keys follow the backend tables.
const countGroups: { title: string; items: [string, string][] }[] = [
  {
    title: "对话",
    items: [
      ["conversations", "对话"],
      ["messages", "消息"],
      ["attachments", "图片与附件"],
      ["office_files", "办公文件"],
      ["artifacts", "工具产物"],
      ["complex_tasks", "复杂任务"],
    ],
  },
  {
    title: "项目",
    items: [
      ["projects", "项目"],
      ["project_materials", "项目资料"],
    ],
  },
  {
    title: "学习",
    items: [
      ["goals", "学习目标"],
      ["learning_intakes", "目标访谈"],
      ["learning_sessions", "学习会话"],
      ["learning_reviews", "复习记录"],
    ],
  },
  {
    title: "计划与提醒",
    items: [
      ["calendar_events", "计划"],
      ["todos", "待办"],
      ["reminders", "提醒"],
      ["plan_occurrences", "单次完成记录"],
      ["plan_segments", "重复规则调整"],
      ["plan_day_orders", "日程排序"],
    ],
  },
  {
    title: "记忆与知识库",
    items: [
      ["memories", "记忆"],
      ["memory_vectors", "记忆向量"],
      ["knowledge_documents", "知识库文件"],
      ["knowledge_chunks", "知识片段"],
      ["knowledge_vectors", "知识向量"],
    ],
  },
  {
    title: "模型用量",
    items: [
      ["usage_calls", "模型调用"],
      ["usage_prices", "模型单价"],
    ],
  },
];

function DataCounts({ counts }: { counts: Record<string, number> }) {
  const known = new Set(countGroups.flatMap((group) => group.items.map(([key]) => key)));
  const others = Object.keys(counts).filter((key) => !known.has(key));
  const groups = others.length
    ? [...countGroups, { title: "其他", items: others.map((key): [string, string] => [key, key]) }]
    : countGroups;
  return (
    <div className="data-count-groups">
      {groups.map((group) => {
        const items = group.items.filter(([key]) => key in counts);
        if (!items.length) return null;
        return (
          <section key={group.title} aria-label={group.title}>
            <h3>{group.title}</h3>
            <div className="data-counts">
              {items.map(([key, label]) => (
                <div key={key}>
                  <span>{label}</span>
                  <strong>{counts[key].toLocaleString("zh-CN")}</strong>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
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
            <p>使用 SQLite 数据库存储</p>
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
