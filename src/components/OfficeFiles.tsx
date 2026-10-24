import { DropdownMenu } from "radix-ui";
import { useEffect, useState, useContext } from "react";
import { RestrictedFileContext, proposeFileSave } from "@/lib/restrictedFiles";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  Download,
  Eye,
  FileText,
  FolderOpen,
  Loader2,
  Save,
  MoreHorizontal,
} from "lucide-react";
import { api, fetchApi, type Artifact, type Attachment } from "@/lib/api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Picture } from "./ImageAttachments";

type Preview = {
  kind: string;
  parts?: { source: string; text: string; cells?: string[] }[];
  tables?: { name: string; rows: string[][] }[];
  warnings?: string[];
  notice?: string;
  truncated?: boolean;
  image?: string;
  page?: number;
  pages?: number;
};

export type DownloadedFile = { name: string; path: string };

export function DownloadResultDialog({
  value,
  onClose,
}: {
  value: DownloadedFile | null;
  onClose: () => void;
}) {
  const [error, setError] = useState("");
  useEffect(() => {
    if (!value) setError("");
  }, [value]);
  return (
    <Dialog
      open={Boolean(value)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="download-result-dialog">
        <DialogHeader>
          <DialogTitle>文件已下载</DialogTitle>
          <DialogDescription>{value?.name}</DialogDescription>
        </DialogHeader>
        <div className="download-result-path">
          <FolderOpen size={18} aria-hidden="true" />
          <code>{value?.path}</code>
        </div>
        {error && <p role="alert">{error}</p>}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              if (!value) return;
              setError("");
              try {
                await invoke("open_download_location", { path: value.path });
              } catch (cause) {
                setError((cause as Error).message);
              }
            }}
          >
            <FolderOpen size={14} />
            打开所在文件夹
          </Button>
          <Button onClick={onClose}>知道了</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FileCard({
  file,
  upload = false,
  compact = false,
  previewOnly = false,
}: {
  file: Pick<Artifact, "id" | "name">;
  upload?: boolean;
  compact?: boolean;
  previewOnly?: boolean;
}) {
  const restricted = useContext(RestrictedFileContext);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [downloaded, setDownloaded] = useState<DownloadedFile | null>(null);
  const prefix = upload ? "files" : "artifacts";
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    setError("");
    void api<Preview>(`/${prefix}/${file.id}/preview?page=${page}`)
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, prefix, file.id, page, retry]);
  async function save(as: boolean) {
    if (previewOnly) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (restricted) {
        await proposeFileSave(restricted, file.id);
        setNotice("保存申请已加入上方文件任务面板，请选择位置并确认");
        return;
      }
      if (isTauri()) {
        if (as) {
          const saved = await invoke<boolean>("save_office_file", {
            fileId: file.id,
            name: file.name,
            upload,
          });
          if (saved) setNotice("文件已另存为");
        } else {
          // “下载” is a normal download: go to the Windows Downloads folder,
          // never into the application's private data directory.
          const path = await invoke<string>("download_office_file", {
            fileId: file.id,
            name: file.name,
            upload,
          });
          setDownloaded({ name: file.name, path });
        }
      } else {
        const response = await fetchApi(
          `/${prefix}/${file.id}/content?download=true`,
        );
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div
        className={`office-file-card${compact ? " office-file-card-compact" : ""}`}
      >
        <FileText size={23} />
        <div className="office-file-copy">
          <strong>{file.name}</strong>
          {!compact && !previewOnly && (
            <small>{upload ? "上传资料 · 原件保留" : "生成文件"}</small>
          )}
        </div>
        <div className="office-file-actions">
          <button
            aria-label={`预览 ${file.name}`}
            onClick={() => {
              setPage(1);
              setPreview(null);
              setOpen(true);
            }}
          >
            <Eye size={14} />
            预览
          </button>
          {!compact && (
            <button
              disabled={saving}
              aria-label={`${restricted ? "申请保存" : "下载"} ${file.name}`}
              onClick={() => void save(false)}
            >
              <Download size={14} />
              {restricted ? "申请保存" : "下载"}
            </button>
          )}
          {!compact && !previewOnly && !restricted && isTauri() && (
            <button
              disabled={saving}
              aria-label={`另存为 ${file.name}`}
              onClick={() => void save(true)}
            >
              <Save size={14} />
              另存为
            </button>
          )}
          {compact && !previewOnly && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button type="button" aria-label={`更多操作 ${file.name}`}>
                  <MoreHorizontal size={16} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="project-menu file-action-menu"
                  sideOffset={6}
                  align="end"
                >
                  <DropdownMenu.Item
                    disabled={saving}
                    onSelect={() => void save(false)}
                  >
                    <Download size={14} />
                    下载
                  </DropdownMenu.Item>
                  {isTauri() && (
                    <DropdownMenu.Item
                      disabled={saving}
                      onSelect={() => void save(true)}
                    >
                      <Save size={14} />
                      另存为
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
        {error && !open && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="office-preview-dialog">
          <DialogHeader>
            <DialogTitle>{file.name}</DialogTitle>
            <DialogDescription>
              {preview?.notice || "文件预览；下载可获取完整文件"}
            </DialogDescription>
          </DialogHeader>
          <div className="office-preview-body">
            {loading ? (
              <p role="status">
                <Loader2 size={16} className="spin" />
                正在准备预览…
              </p>
            ) : error ? (
              <div role="alert">
                <p>{error}，原文件仍可下载。</p>
                <button onClick={() => setRetry((v) => v + 1)}>重试预览</button>
              </div>
            ) : preview?.kind === "pdf" ? (
              <img
                className="office-pdf-page"
                src={preview.image}
                alt={`PDF 第 ${page} 页`}
              />
            ) : (
              <>
                {!!preview?.warnings?.length && (
                  <p className="office-preview-warning">
                    {preview.warnings.join("；")}
                  </p>
                )}
                {preview?.parts?.map((part, index) => (
                  <section key={index}>
                    <small>{part.source}</small>
                    {preview.kind === "table" ? (
                      <div className="office-preview-table">
                        <table>
                          <tbody>
                            {(part.cells
                              ? [part.cells]
                              : part.text
                                  .split("\n")
                                  .map((row) => row.split(" | "))
                            ).map((row, i) => (
                              <tr key={i}>
                                {row.map((cell, j) => (
                                  <td key={j}>{cell}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <pre>{part.text}</pre>
                    )}
                  </section>
                ))}
                {preview?.tables?.map((table, index) => (
                  <section key={index}>
                    <h3>{table.name}</h3>
                    <div className="office-preview-table">
                      <table>
                        <tbody>
                          {table.rows.map((row, i) => (
                            <tr key={i}>
                              {row.map((cell, j) => (
                                <td key={j}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}
                {preview?.truncated && (
                  <p>预览只展示前 100 个片段，下载可查看完整文件。</p>
                )}
              </>
            )}
          </div>
          <div className="office-preview-footer">
            {preview?.kind === "pdf" && (
              <>
                <button
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((v) => v - 1)}
                >
                  上一页
                </button>
                <span>
                  {page} / {preview.pages} 页
                </span>
                <button
                  disabled={page >= (preview.pages || 1) || loading}
                  onClick={() => setPage((v) => v + 1)}
                >
                  下一页
                </button>
              </>
            )}
            {!previewOnly && (
              <button disabled={saving} onClick={() => void save(isTauri())}>
                {restricted ? "申请保存" : isTauri() ? "另存为" : "下载文件"}
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <DownloadResultDialog
        value={downloaded}
        onClose={() => setDownloaded(null)}
      />
    </>
  );
}

export function MessageAttachment({ id }: { id: string }) {
  const [file, setFile] = useState<Attachment | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api<Attachment>(`/attachments/${id}`)
      .then((value) => {
        if (live) setFile(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [id]);
  if (error) return <span role="alert">附件信息加载失败：{error}</span>;
  if (!file) return <span>读取附件信息…</span>;
  return file.file_status ? (
    <FileCard file={file} upload />
  ) : (
    <Picture id={id} name={file.name} />
  );
}
