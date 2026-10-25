import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  BookOpen,
  Download,
  FileText,
  Folder,
  FolderUp,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { api, fetchApi } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ConfirmDelete, ErrorNotice, Markdown, Toast } from "./common";
import { DownloadResultDialog, type DownloadedFile } from "./OfficeFiles";
import { KnowledgeSources, type KnowledgeSource } from "./KnowledgeSources";

type Document = {
  id: string;
  batch_id: string;
  relative_path: string;
  size: number;
  status: string;
  error: string;
  warnings: string[];
  created_at: string;
};
type Status = {
  enabled: boolean;
  documents: number;
  chunks: number;
  indexed: number;
  parsing: number;
  indexing: boolean;
  mode: string;
  error: string;
};
const statusLabels: Record<string, string> = {
  queued: "等待解析",
  parsing: "解析中",
  ready: "可检索",
  partial: "部分可检索",
  failed: "解析失败",
  unsupported: "仅保存原件",
  empty: "无可读正文",
};

function FileTree({
  documents,
  prefix = "",
  selected,
  onSelect,
}: {
  documents: Document[];
  prefix?: string;
  selected?: string;
  onSelect: (value: Document) => void;
}) {
  const folders = new Map<string, Document[]>();
  const files: Document[] = [];
  for (const doc of documents) {
    const rest = doc.relative_path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) files.push(doc);
    else {
      const name = rest.slice(0, slash);
      folders.set(name, [...(folders.get(name) || []), doc]);
    }
  }
  return (
    <ul className="knowledge-tree">
      {[...folders].map(([name, rows]) => (
        <li key={name}>
          <details open>
            <summary>
              <Folder size={15} />
              {name}
            </summary>
            <FileTree
              documents={rows}
              prefix={`${prefix}${name}/`}
              selected={selected}
              onSelect={onSelect}
            />
          </details>
        </li>
      ))}
      {files.map((doc) => (
        <li key={doc.id}>
          <button
            aria-current={selected === doc.id ? "true" : undefined}
            onClick={() => onSelect(doc)}
            title={doc.relative_path}
          >
            <FileText size={15} />
            <span>{doc.relative_path.slice(prefix.length)}</span>
            <small>{statusLabels[doc.status] || doc.status}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function KnowledgePage({
  openSource,
  onOpened,
}: {
  openSource?: KnowledgeSource;
  onOpened: () => void;
}) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [status, setStatus] = useState<Status>();
  const [selected, setSelected] = useState<Document>();
  const [preview, setPreview] = useState<{
    content: string;
    truncated: boolean;
  }>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [updatingConfig, setUpdatingConfig] = useState(false);
  const [deleting, setDeleting] = useState<Document>();
  const [downloaded, setDownloaded] = useState<DownloadedFile | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeSource[]>([]);
  const [related, setRelated] = useState<KnowledgeSource>();
  const [searched, setSearched] = useState(false);
  const lock = useRef(false);
  const requestVersion = useRef(0);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const request = ++requestVersion.current;
    const [docs, info] = await Promise.all([
      api<Document[]>("/knowledge/documents"),
      api<Status>("/knowledge/config"),
    ]);
    if (request === requestVersion.current) {
      setDocuments(docs);
      setStatus(info);
    }
    return docs;
  }, []);
  useEffect(() => {
    folder.current?.setAttribute("webkitdirectory", "");
    let live = true;
    const refresh = () => {
      if (lock.current) return;
      const request = ++requestVersion.current;
      void Promise.all([
        api<Document[]>("/knowledge/documents"),
        api<Status>("/knowledge/config"),
      ])
        .then(([docs, info]) => {
          if (live && request === requestVersion.current) {
            setDocuments(docs);
            setStatus(info);
          }
        })
        .catch((e: Error) => {
          if (live && request === requestVersion.current) setError(e.message);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!openSource || !status) return;
    const doc = documents.find((row) => row.id === openSource.document_id);
    if (doc) {
      setSelected(doc);
      setRelated(openSource);
    } else setError("这份知识库文件已移除，无法打开原文。");
    onOpened();
  }, [openSource, status, documents, onOpened]);
  useEffect(() => {
    setPreview(undefined);
    setPreviewLoading(false);
    if (!selected || !/\.(md|markdown)$/i.test(selected.relative_path)) return;
    let live = true;
    setPreviewLoading(true);
    api<{ content: string; truncated: boolean }>(
      `/knowledge/documents/${selected.id}/preview`,
    )
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setPreviewLoading(false);
      });
    return () => {
      live = false;
    };
  }, [selected?.id]);
  async function perform(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    requestVersion.current += 1;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function upload(list: FileList | null) {
    if (!list?.length) return;
    const chosen = Array.from(list);
    await perform(async () => {
      const body = new FormData();
      for (const file of chosen) body.append("files", file);
      body.append(
        "paths",
        JSON.stringify(
          chosen.map((file) => file.webkitRelativePath || file.name),
        ),
      );
      const saved: Document[] = await (
        await fetchApi("/knowledge/import", { method: "POST", body })
      ).json();
      await load();
      setSelected(saved[0]);
      setRelated(undefined);
      setNotice(`已导入 ${saved.length} 个文件，正在后台整理`);
    });
    if (files.current) files.current.value = "";
    if (folder.current) folder.current.value = "";
  }
  const current = documents.find((row) => row.id === selected?.id) || selected;
  const batches = [...new Set(documents.map((row) => row.batch_id))];
  return (
    <div className="knowledge-page page-content">
      <div className="page-heading">
        <div>
          <h1>知识库</h1>
          <p>保存你的资料，让 XiaoXi 更了解你的背景与知识。</p>
        </div>
        <div className="module-actions">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => folder.current?.click()}
          >
            <FolderUp size={16} />
            导入文件夹
          </Button>
          <Button disabled={busy} onClick={() => files.current?.click()}>
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Upload size={16} />
            )}
            {busy ? "正在处理…" : "导入文件"}
          </Button>
        </div>
      </div>
      <input
        ref={files}
        type="file"
        multiple
        hidden
        onChange={(e) => void upload(e.target.files)}
      />
      <input
        ref={folder}
        type="file"
        multiple
        hidden
        onChange={(e) => void upload(e.target.files)}
      />
      {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      {error && <ErrorNotice message={error} onClose={() => setError("")} />}
      <section className="knowledge-config">
        <div>
          <strong>知识库检索</strong>
          <p>开启后，对话和学习会按需参考相关片段。</p>
          <small>
            {status
              ? `${status.documents} 个文件 · ${status.chunks} 个片段 · ${status.mode === "hybrid" ? "关键词与语义检索" : "关键词检索"}${status.parsing ? ` · ${status.parsing} 个文件整理中` : ""}${status.indexing ? ` · 语义索引 ${status.indexed}/${status.chunks}` : ""}`
              : "正在读取知识库…"}
          </small>
        </div>
        <label className="module-toggle">
          <input
            type="checkbox"
            role="switch"
            aria-label="启用知识库检索"
            checked={status?.enabled || false}
            aria-busy={updatingConfig}
            disabled={busy || !status}
            onChange={(e) => {
              const enabled = e.target.checked;
              void perform(async () => {
                setUpdatingConfig(true);
                try {
                  setStatus(
                    await api<Status>("/knowledge/config", "PUT", { enabled }),
                  );
                  setResults([]);
                  setSearched(false);
                } finally {
                  setUpdatingConfig(false);
                }
              });
            }}
          />
          <span role="status">
            {updatingConfig
              ? "正在更新…"
              : status?.enabled
                ? "已开启"
                : "已关闭"}
          </span>
        </label>
      </section>
      {status?.error && <ErrorNotice tone="warning" message={status.error} />}
      <form
        className="knowledge-search"
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            setResults(
              await api<KnowledgeSource[]>(
                `/knowledge/search?query=${encodeURIComponent(query)}`,
              ),
            );
            setSearched(true);
          });
        }}
      >
        <Input
          aria-label="搜索知识库"
          placeholder={
            status?.enabled ? "搜索知识库中的内容…" : "开启检索后可搜索资料"
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!status?.enabled || busy}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={!status?.enabled || busy || !query.trim()}
        >
          <Search size={16} />
          搜索
        </Button>
      </form>
      <KnowledgeSources sources={results} />
      {searched && !results.length && (
        <p className="module-caption">没有找到相关片段，可换个关键词。</p>
      )}
      <div className="knowledge-workspace">
        <aside aria-label="知识库文件">
          <h2>
            <BookOpen size={17} />
            资料目录
          </h2>
          {!documents.length && (
            <p className="module-empty">导入文件或文件夹，从第一份资料开始。</p>
          )}
          {batches.map((batch, index) => (
            <details key={batch} open className="knowledge-batch">
              <summary>
                导入 {index + 1} ·{" "}
                {documents.filter((row) => row.batch_id === batch).length}{" "}
                个文件
              </summary>
              <FileTree
                documents={documents.filter((row) => row.batch_id === batch)}
                selected={selected?.id}
                onSelect={(row) => {
                  setSelected(row);
                  setRelated(undefined);
                  setError("");
                }}
              />
            </details>
          ))}
        </aside>
        <section className="knowledge-preview" aria-label="文件预览">
          {current ? (
            <>
              <header>
                <div>
                  <h2>{current.relative_path}</h2>
                  <small>
                    {statusLabels[current.status]} ·{" "}
                    {(current.size / 1024).toFixed(1)} KB
                  </small>
                </div>
                <div className="module-actions">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="下载原文件"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const name =
                          current.relative_path.split("/").at(-1) || "文件";
                        if (isTauri()) {
                          const path = await invoke<string>(
                            "download_knowledge_file",
                            { fileId: current.id, name },
                          );
                          setDownloaded({ name, path });
                        } else {
                          const response = await fetchApi(
                            `/knowledge/documents/${current.id}/download`,
                          );
                          const url = URL.createObjectURL(
                            await response.blob(),
                          );
                          const anchor = document.createElement("a");
                          anchor.href = url;
                          anchor.download = name;
                          anchor.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        }
                      })
                    }
                  >
                    <Download size={16} />
                  </Button>
                  {["failed", "empty", "partial"].includes(current.status) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      aria-label="重试解析"
                      onClick={() =>
                        void perform(async () => {
                          await api(
                            `/knowledge/documents/${current.id}/retry`,
                            "POST",
                          );
                          await load();
                          setNotice("已重新加入解析队列");
                        })
                      }
                    >
                      <RotateCcw size={16} />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="移除知识库文件"
                    disabled={busy}
                    onClick={() => setDeleting(current)}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              </header>
              {current.error && (
                <ErrorNotice
                  tone={current.status === "failed" ? "error" : "info"}
                  message={current.error}
                />
              )}
              {current.warnings.map((warning) => (
                <ErrorNotice key={warning} tone="warning" message={warning} />
              ))}
              {related?.document_id === current.id && (
                <div className="knowledge-related">
                  <strong>{related.locator} · 引用片段</strong>
                  <Markdown>{related.excerpt}</Markdown>
                </div>
              )}
              {previewLoading && <p role="status">正在读取 Markdown…</p>}
              {preview ? (
                <>
                  {preview.truncated && (
                    <ErrorNotice
                      tone="warning"
                      message="正文预览已截断，下载可获取完整原文件。"
                    />
                  )}
                  <Markdown>{preview.content}</Markdown>
                </>
              ) : (
                !previewLoading &&
                !/\.(md|markdown)$/i.test(current.relative_path) && (
                  <p className="module-empty">
                    此类型显示文件信息，支持解析的正文可用于检索。正文预览目前支持
                    Markdown。
                  </p>
                )
              )}
            </>
          ) : (
            <p className="module-empty">从左侧选择一份资料查看。</p>
          )}
        </section>
      </div>
      <ConfirmDelete
        open={Boolean(deleting)}
        title="移除这份知识库文件？"
        description="将移除知识库副本和检索索引，本地源文件保留。"
        label="移除文件"
        error={error}
        onClose={() => {
          if (!busy) setDeleting(undefined);
        }}
        onConfirm={() =>
          perform(async () => {
            if (!deleting) return;
            await api(`/knowledge/documents/${deleting.id}`, "DELETE");
            if (selected?.id === deleting.id) {
              setSelected(undefined);
              setPreview(undefined);
              setRelated(undefined);
            }
            setDeleting(undefined);
            await load();
            setNotice("已移除知识库文件");
          })
        }
      />
      <DownloadResultDialog
        value={downloaded}
        onClose={() => setDownloaded(null)}
      />
    </div>
  );
}
