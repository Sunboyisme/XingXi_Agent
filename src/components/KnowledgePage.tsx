import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Download,
  FileText,
  Folder,
  FolderUp,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, downloadApiFile, fetchApi } from "@/lib/api";
import { nativeFile, useNativeDrop } from "@/lib/nativeDrop";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ConfirmDelete, ErrorNotice, Hint, Markdown, Toast } from "./common";
import { DownloadResultDialog, type DownloadedFile } from "./OfficeFiles";
import { TrashIcon } from "./SoftIcons";
import type { KnowledgeSource } from "./KnowledgeSources";
import { errorMessage } from "@/lib/utils";

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
  onDelete,
  busy,
}: {
  documents: Document[];
  prefix?: string;
  selected?: string;
  onSelect: (value: Document) => void;
  onDelete: (label: string, rows: Document[]) => void;
  busy: boolean;
}) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const selectedPath = documents.find(
    (row) => row.id === selected,
  )?.relative_path;
  useEffect(() => {
    if (selectedPath)
      setClosed(
        (previous) =>
          new Set(
            [...previous].filter(
              (name) => !selectedPath.startsWith(`${prefix}${name}/`),
            ),
          ),
      );
  }, [selectedPath, prefix]);
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
      {[...folders]
        .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
        .map(([name, rows]) => (
          <li key={name}>
            <div className="knowledge-tree-row">
              <Hint label={`${prefix}${name}`}><button
                className="knowledge-file-select"
                aria-expanded={!closed.has(name)}
                onClick={() =>
                  setClosed((previous) => {
                    const next = new Set(previous);
                    if (next.has(name)) next.delete(name);
                    else next.add(name);
                    return next;
                  })
                }
              >
                {closed.has(name) ? (
                  <ChevronRight size={13} />
                ) : (
                  <ChevronDown size={13} />
                )}
                <Folder size={15} />
                <span>{name}</span>
              </button></Hint>
              <small
                className="knowledge-folder-count"
                aria-label={`${rows.length} 个文件`}
              >
                {rows.length}
              </small>
              <Hint label="删除文件夹中的知识库副本">
                <Button
                  variant="ghost"
                  size="icon"
                  className="knowledge-row-delete"
                  disabled={busy}
                  aria-label={`删除文件夹 ${prefix}${name}`}
                  onClick={() => onDelete(`${prefix}${name}`, rows)}
                >
                  <TrashIcon size={15} />
                </Button>
              </Hint>
            </div>
            {!closed.has(name) && (
              <FileTree
                documents={rows}
                prefix={`${prefix}${name}/`}
                selected={selected}
                onSelect={onSelect}
                onDelete={onDelete}
                busy={busy}
              />
            )}
          </li>
        ))}
      {files
        .sort((a, b) => a.relative_path.localeCompare(b.relative_path, "zh-CN"))
        .map((doc) => (
          <li key={doc.id}>
            <div className="knowledge-tree-row">
              <Hint label={<><strong>{doc.relative_path}</strong><span>{statusLabels[doc.status] || doc.status}</span><span>导入于 {new Date(doc.created_at).toLocaleString("zh-CN", { hour12: false })}</span></>}><button
                className="knowledge-file-select"
                aria-current={selected === doc.id ? "true" : undefined}
                onClick={() => onSelect(doc)}
              >
                <FileText size={15} />
                <span>{doc.relative_path.slice(prefix.length)}</span>
              </button></Hint>
              <Hint label={statusLabels[doc.status] || doc.status}>
              <span
                className={`knowledge-file-status is-${doc.status}`}
                role="img"
                aria-label={statusLabels[doc.status] || doc.status}
              >
                {doc.status === "ready" ? (
                  <CheckCircle2 size={13} />
                ) : ["queued", "parsing"].includes(doc.status) ? (
                  <Clock3 size={13} />
                ) : (
                  <CircleAlert size={13} />
                )}
              </span>
              </Hint>
              <Hint label="删除知识库副本">
                <Button
                  variant="ghost"
                  size="icon"
                  className="knowledge-row-delete"
                  disabled={busy}
                  aria-label={`删除文件 ${doc.relative_path}`}
                  onClick={() => onDelete(doc.relative_path, [doc])}
                >
                  <TrashIcon size={15} />
                </Button>
              </Hint>
            </div>
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
  const [deleting, setDeleting] = useState<{
    label: string;
    documents: Document[];
  }>();
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
        .catch((e) => {
          if (live && request === requestVersion.current) setError(errorMessage(e));
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
      .catch((e) => {
        if (live) setError(errorMessage(e));
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
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  // Files and whole folders dropped from the desktop import with their relative paths.
  const dropZone = useRef<HTMLDivElement>(null);
  useNativeDrop(
    dropZone,
    (dropped) =>
      importFiles(
        dropped
          .filter((item) => !item.directory)
          .map((item) => ({ file: nativeFile(item), path: item.relative_path })),
      ),
    setError,
    true,
    busy,
  );
  async function upload(list: FileList | null) {
    if (!list?.length) return;
    await importFiles(
      Array.from(list, (file) => ({
        file,
        path: file.webkitRelativePath || file.name,
      })),
    );
  }
  async function importFiles(chosen: { file: File; path: string }[]) {
    if (!chosen.length) return;
    await perform(async () => {
      const body = new FormData();
      for (const item of chosen) body.append("files", item.file);
      body.append("paths", JSON.stringify(chosen.map((item) => item.path)));
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
  const current = documents.find((row) => row.id === selected?.id);
  function selectDocument(row: Document) {
    setSelected(row);
    setRelated(undefined);
    setError("");
  }
  function requestDelete(label: string, rows: Document[]) {
    setError("");
    setDeleting({ label, documents: rows });
  }
  return (
    <div className="knowledge-page page-content" ref={dropZone}>
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
      <div className="knowledge-toolbar">
        <section className="knowledge-config" aria-label="知识库检索设置">
          <div>
            <strong>知识库检索</strong>
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
                      await api<Status>("/knowledge/config", "PUT", {
                        enabled,
                      }),
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
        <form
          className="knowledge-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (!status?.enabled || !query.trim() || busy) return;
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
          {searched && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label="清除搜索，返回资料目录"
              onClick={() => {
                setQuery("");
                setResults([]);
                setSearched(false);
              }}
            >
              <X size={16} />
            </Button>
          )}
        </form>
      </div>
      {status?.error && <ErrorNotice tone="warning" message={status.error} />}
      <div className="knowledge-workspace">
        <aside aria-label="知识库文件">
          <h2>
            <BookOpen size={17} />
            {searched
              ? `搜索结果 · ${results.length}`
              : `资料目录 · ${documents.length}`}
          </h2>
          <div
            className="knowledge-directory-scroll"
            tabIndex={0}
            aria-label={searched ? "搜索结果列表" : "资料目录列表"}
          >
            {searched ? (
              <>
                {!results.length && (
                  <p className="module-empty">
                    没有找到相关片段，可换个关键词。
                  </p>
                )}
                {results.map((source) => (
                  <button
                    key={source.chunk_id}
                    className="knowledge-search-result"
                    aria-current={
                      related?.chunk_id === source.chunk_id ? "true" : undefined
                    }
                    onClick={() => {
                      const row = documents.find(
                        (doc) => doc.id === source.document_id,
                      );
                      if (row) {
                        selectDocument(row);
                        setRelated(source);
                      } else setError("这份知识库文件已移除。");
                    }}
                  >
                    <strong>{source.relative_path}</strong>
                    <small>{source.locator}</small>
                    <p>{source.excerpt.slice(0, 180)}</p>
                  </button>
                ))}
              </>
            ) : (
              <>
                {!documents.length && (
                  <p className="module-empty">
                    导入或直接拖入文件、文件夹，从第一份资料开始。
                  </p>
                )}
                <FileTree
                  documents={documents}
                  selected={selected?.id}
                  onSelect={selectDocument}
                  onDelete={requestDelete}
                  busy={busy}
                />
              </>
            )}
          </div>
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
                          await downloadApiFile(
                            `/knowledge/documents/${current.id}/download`,
                            name,
                          );
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
                  <Hint label="删除知识库副本">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="删除知识库文件"
                      disabled={busy}
                      onClick={() =>
                        requestDelete(current.relative_path, [current])
                      }
                    >
                      <Trash2 size={16} />
                    </Button>
                  </Hint>
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
        title={
          deleting?.documents.length === 1
            ? "删除这份知识库文件？"
            : "删除文件夹中的资料？"
        }
        description={`将删除“${deleting?.label || ""}”的 ${deleting?.documents.length || 0} 份知识库副本和检索索引，本地源文件保留。`}
        label="确认删除"
        error={error}
        onClose={() => {
          if (!busy) setDeleting(undefined);
        }}
        onConfirm={() =>
          perform(async () => {
            if (!deleting) return;
            const removed = new Set<string>();
            try {
              for (const doc of deleting.documents) {
                await api(`/knowledge/documents/${doc.id}`, "DELETE");
                removed.add(doc.id);
                setDocuments((previous) =>
                  previous.filter((row) => row.id !== doc.id),
                );
                if (selected?.id === doc.id) {
                  setSelected(undefined);
                  setPreview(undefined);
                  setRelated(undefined);
                }
              }
              setDeleting(undefined);
              setNotice(`已删除 ${removed.size} 份知识库副本`);
            } finally {
              setResults([]);
              setSearched(false);
              setDeleting((previous) => {
                if (!previous) return undefined;
                const remaining = previous.documents.filter(
                  (doc) => !removed.has(doc.id),
                );
                return remaining.length
                  ? { ...previous, documents: remaining }
                  : undefined;
              });
              await load();
            }
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
