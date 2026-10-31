import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ArrowLeft, FolderOpen, Plus, RefreshCw, Trash2, Upload, X, CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { api, fetchApi, type Conversation, type Project } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { CreationPage } from "./CreationPage";
import { ConfirmDelete, ErrorNotice, Hint } from "./common";
import { FileCard } from "./OfficeFiles";
import { Picture } from "./ImageAttachments";
import "@/styles/projects-workspace.css";
import { errorMessage } from "@/lib/utils";
import { useNativeDrop } from "@/lib/nativeDrop";

export type ProjectManagementRequest = {
  id: string | null;
  action: "create" | "settings" | "library" | "delete";
  key: number;
};
export type ProjectMaterial = {
  id: string;
  file_id: string;
  source_file_id?: string | null;
  name: string;
  image: boolean;
  file_status: string;
  error: string;
  created_at?: string;
};
type Source = { id: string; name: string; kind: string };

export function materialStatus(item: ProjectMaterial) {
  return item.file_status === "ready"
    ? "可用"
    : item.file_status === "partial"
      ? "部分可读"
      : item.file_status === "failed"
        ? item.error || "解析失败"
        : "正在解析…";
}

function MaterialState({ item }: { item: ProjectMaterial }) {
  const label = materialStatus(item);
  return <Hint label={label}><span className="project-material-state" data-state={item.file_status} role="img" aria-label={`资料状态：${label}`} tabIndex={0}>
    {item.file_status === "ready" ? <CheckCircle2 size={15} />
      : ["queued", "parsing"].includes(item.file_status) ? <Loader2 size={15} className="spin" /> : <CircleAlert size={15} />}
  </span></Hint>;
}

export function ProjectManagement({
  projects,
  conversations,
  currentId,
  request,
  refresh,
  onProject,
  onDeleted,
  onLibraryChange,
  onEditorOpenChange,
}: {
  projects: Project[];
  conversations: Conversation[];
  currentId: string | null;
  request: ProjectManagementRequest | null;
  refresh: () => Promise<void>;
  onEditorOpenChange?: (open: boolean) => void;
  onProject: (id: string, saved?: Project) => void;
  onDeleted?: (id: string) => void;
  onLibraryChange?: () => void;
}) {
  const [editing, setEditing] = useState<Project | null | undefined>();
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [library, setLibrary] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [droppingFolders, setDroppingFolders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [materials, setMaterials] = useState<ProjectMaterial[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceError, setSourceError] = useState("");
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const lock = useRef(false);
  const sequence = useRef(0);
  const editorSequence = useRef(0);
  const handledRequest = useRef<ProjectManagementRequest | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderDropTarget = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const current = conversations.find((item) => item.id === currentId);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const editorOpen = editing !== undefined;
  useNativeDrop(
    folderDropTarget,
    (files) => appendWorkspaceFolders(files.map((file) => file.path)),
    setError,
    false,
    !editorOpen || !request || picking || busy,
    `project-folders:${request?.key ?? "closed"}`,
    setDroppingFolders,
    true,
  );

  useEffect(() => {
    onEditorOpenChange?.(editorOpen || Boolean(library));
  }, [editorOpen, library, onEditorOpenChange]);
  useEffect(() => {
    if (!request) {
      editorSequence.current++;
      setEditing(undefined);
      setDroppingFolders(false);
    }
  }, [request]);

  useEffect(() => {
    if (!request || request === handledRequest.current || busy) return;
    const project = projects.find((item) => item.id === request.id);
    if (request.action !== "create" && !project) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    handledRequest.current = request;
    editorSequence.current++;
    sequence.current++;
    setEditing(undefined);
    setDeleting(null);
    setLibrary(null);
    setBatch(false);
    setSelected([]);
    setConfirmBatch(false);
    setError("");
    setNotice("");
    setDroppingFolders(false);
    if (
      request.action === "create" ||
      (project && request.action === "settings")
    ) {
      setEditing(project || null);
      setName(project?.name || "");
      setInstructions(project?.instructions || "");
      setWorkspacePaths(project?.workspace_paths || []);
    } else if (project && request.action === "library") {
      setLibrary(project);
      setBatch(false);
      setSelected([]);
      setConfirmBatch(false);
    } else if (project && request.action === "delete") setDeleting(project);
    // The request key is the explicit open action; refresh must not reopen dialogs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, projects, busy]);
  useEffect(
    () => () => {
      sequence.current++;
      editorSequence.current++;
    },
    [],
  );

  async function loadLibrary(project: Project) {
    const own = ++sequence.current;
    setLoadingLibrary(true);
    try {
      const [files, inputs] = await Promise.allSettled([
        api<ProjectMaterial[]>(`/projects/${project.id}/materials`),
        current?.project_id === project.id
          ? api<Source[]>(`/conversations/${current.id}/files`)
          : Promise.resolve([]),
      ]);
      if (sequence.current !== own || libraryRef.current?.id !== project.id)
        return;
      if (files.status === "rejected") throw files.reason;
      setMaterials(files.value);
      setSources(
        inputs.status === "fulfilled"
          ? inputs.value.filter((item) => !item.kind.startsWith("project_") && !files.value.some((material) => material.source_file_id === item.id))
          : [],
      );
      setSourceError(
        inputs.status === "rejected"
          ? "当前聊天资料暂时无法读取，请稍后刷新。"
          : "",
      );
      setError("");
      setSelected((ids) =>
        ids.filter((id) => files.value.some((item) => item.id === id)),
      );
    } catch (cause) {
      if (sequence.current === own) setError(errorMessage(cause));
    } finally {
      if (sequence.current === own) setLoadingLibrary(false);
    }
  }
  useEffect(() => {
    if (!library) return;
    setMaterials([]);
    setSources([]);
    setSourceError("");
    setError("");
    void loadLibrary(library);
    return () => {
      sequence.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library?.id, currentId, current?.project_id]);
  useEffect(() => {
    if (
      !library ||
      !materials.some((item) =>
        ["queued", "parsing"].includes(item.file_status),
      )
    )
      return;
    const timer = window.setTimeout(() => void loadLibrary(library), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials, library]);
  useEffect(() => {
    if (!selected.length) setConfirmBatch(false);
  }, [selected.length]);

  async function mutate(operation: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let applied = false;
    try {
      await operation();
      applied = true;
      await refresh();
    } catch (cause) {
      setError(
        applied
          ? "修改已保存，列表暂未刷新，请稍后刷新。"
          : errorMessage(cause),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function closeEditor() {
    editorSequence.current++;
    setEditing(undefined);
    setDroppingFolders(false);
  }
  function appendWorkspaceFolders(values: string[]) {
    setError("");
    const unique = new Map(
      workspacePaths.map((path) => [
        path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(),
        path,
      ]),
    );
    for (const path of values) {
      const key = path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
      if (!unique.has(key)) unique.set(key, path);
    }
    if (unique.size > 20) {
      setError("每个项目最多关联 20 个本地文件夹，请减少选择后重试。");
      return;
    }
    setWorkspacePaths([...unique.values()]);
  }
  async function chooseWorkspace() {
    if (!isTauri() || !editorOpen || picking || droppingFolders || busy) return;
    const own = editorSequence.current;
    setPicking(true);
    setError("");
    try {
      const value = await invoke<string[] | null>("pick_project_workspaces", {
        initialPath: workspacePaths.at(-1) || null,
      });
      if (own !== editorSequence.current || value === null) return;
      appendWorkspaceFolders(value);
    } catch (cause) {
      if (own === editorSequence.current)
        setError(`无法选择文件夹：${errorMessage(cause)}`);
    } finally {
      setPicking(false);
    }
  }
  async function remove(ids: string[]) {
    if (!library || !ids.length) return;
    const project = library;
    await mutate(async () => {
      const value = await api<{ deleted: number; cleanup_pending: number }>(
        `/projects/${project.id}/materials/batch-remove`,
        "POST",
        { material_ids: ids },
      );
      setSelected([]);
      setConfirmBatch(false);
      if (value.cleanup_pending)
        setNotice("资料已移除，部分本地缓存暂未清理，可稍后重试。");
      await loadLibrary(project);
      onLibraryChange?.();
    });
  }

  function removeAction(item: ProjectMaterial) {
    return !batch && <Button size="sm" variant="ghost" data-delete-action disabled={busy}
      aria-label={`移除项目资料 ${item.name}`} onClick={() => void remove([item.id])}>
      <Trash2 size={13} />移除
    </Button>;
  }

  return (
    <>
      {error && !editorOpen && !library && !deleting && !confirmBatch && (
        <div className="project-management-toast">
          <ErrorNotice message={error} onClose={() => setError("")} />
        </div>
      )}
      {editorOpen && (
        <CreationPage
          className="project-creation"
          title={editing ? "编辑项目" : "新建项目"}
          description="集中管理相关对话与资料，作为 XiaoXi 的项目参考。"
          backLabel="返回"
          onBack={closeEditor}
          busy={busy}
          actions={
            <>
              {" "}
              <Button variant="ghost" disabled={busy} onClick={closeEditor}>
                取消
              </Button>
              <Button
                disabled={busy || picking || droppingFolders || !name.trim()}
                onClick={() => {
                  const own = editorSequence.current;
                  void mutate(async () => {
                    const creating = !editing;
                    const value = await api<Project>(
                      editing ? `/projects/${editing.id}` : "/projects",
                      editing ? "PUT" : "POST",
                      {
                        name: name.trim(),
                        instructions,
                        workspace_paths: workspacePaths,
                      },
                    );
                    if (own !== editorSequence.current) return;
                    closeEditor();
                    if (creating) onProject(value.id, value);
                  });
                }}
              >
                {busy ? "保存中…" : "保存"}
              </Button>{" "}
            </>
          }
        >
          <div className="project-creation-basics">
            <label>
              项目名称
              <Input
                value={name}
                disabled={busy}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              项目说明（可选）
              <Textarea
                value={instructions}
                disabled={busy}
                maxLength={12000}
                rows={3}
                placeholder="项目目标、背景和回答要求…"
                onChange={(event) => setInstructions(event.target.value)}
              />
            </label>
          </div>
          <section
            ref={folderDropTarget}
            className="project-creation-folders"
            aria-busy={picking || droppingFolders}
            onDragOver={(event) => {
              if (!isTauri()) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!isTauri()) {
                event.preventDefault();
                setError("请在桌面端拖入本地文件夹。");
              }
            }}
          >
            <header>
              <div>
                <h3>关联本地文件夹</h3>
                <p>可选 · 已选择 {workspacePaths.length} / 20</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  !isTauri() || busy || picking || droppingFolders || workspacePaths.length >= 20
                }
                onClick={() => void chooseWorkspace()}
              >
                <Plus size={14} />
                {picking ? "正在选择…" : droppingFolders ? "正在添加…" : "添加文件夹"}
              </Button>
            </header>
            {workspacePaths.length ? (
              <ul
                className="project-folder-list"
                aria-label="已关联的本地文件夹"
              >
                {workspacePaths.map((path) => (
                  <li key={path}>
                    <FolderOpen size={16} aria-hidden="true" />
                    <Hint
                      label={
                        <>
                          <strong>{path}</strong>
                          <span>仅供此项目只读访问</span>
                        </>
                      }
                    >
                      <span className="project-folder-copy" tabIndex={0}>
                        <strong>
                          {path.split(/[\\/]/).filter(Boolean).at(-1) || path}
                        </strong>
                        <small>{path}</small>
                      </span>
                    </Hint>
                    <Hint label="移除关联，保存后生效">
                      <button
                        type="button"
                        className="icon-button"
                        data-delete-action
                        aria-label={`移除文件夹 ${path}`}
                        disabled={busy || picking || droppingFolders}
                        onClick={() =>
                          setWorkspacePaths((paths) =>
                            paths.filter((item) => item !== path),
                          )
                        }
                      >
                        <X size={15} />
                      </button>
                    </Hint>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="project-folders-empty">
                <FolderOpen size={24} aria-hidden="true" />
                <p>拖入文件夹到此处，或点击添加；支持同时添加多个。</p>
              </div>
            )}
            <p className="project-workspace-hint">
              {isTauri()
                ? "仅供此项目读取。移除关联并保存后取消访问。"
                : "请在桌面端添加本地文件夹。"}
            </p>
          </section>
          {error && (
            <p className="project-creation-error" role="alert">
              {error}
            </p>
          )}
        </CreationPage>
      )}
      <ConfirmDelete
        open={Boolean(deleting)}
        title="删除这个项目？"
        description="聊天会移回未加入项目的对话列表；项目专属资料副本和项目记忆会删除，原聊天附件和成果保留。"
        label="删除项目"
        error={error}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting || busy) return;
          const id = deleting.id;
          await mutate(async () => {
            await api(`/projects/${id}`, "DELETE");
            setDeleting(null);
            onDeleted?.(id);
          });
        }}
      />
      {library && <section className="project-library-page" aria-label="项目资料库">
          <header className="project-library-page-header">
            <Button variant="ghost" disabled={busy} onClick={() => {
              sequence.current++; setLibrary(null); setSelected([]); setConfirmBatch(false);
              requestAnimationFrame(() => returnFocus.current?.focus({ preventScroll: true }));
            }}><ArrowLeft size={16} />返回</Button>
            <h1>{library.name} · 项目资料</h1>
            <p>保存独立副本，同项目对话可读取。</p>
          </header>
          <div className="project-library project-library-shared">
          <div className="project-library-actions">
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept=".png,.jpg,.jpeg,.webp,.gif,.docx,.pdf,.xlsx,.txt,.md,.csv,.json"
              onChange={(event) => {
                const files = [...(event.target.files || [])];
                event.target.value = "";
                if (!library || !files.length) return;
                const project = library;
                void mutate(async () => {
                  try {
                    for (const file of files) {
                      const body = new FormData();
                      body.append("file", file);
                      await fetchApi(
                        `/projects/${project.id}/materials/upload`,
                        { method: "POST", body },
                      );
                    }
                  } finally {
                    await loadLibrary(project);
                    onLibraryChange?.();
                  }
                });
              }}
            />
            <Button disabled={busy} onClick={() => fileInput.current?.click()}>
              <Upload size={15} />
              上传资料
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => library && void loadLibrary(library)}
            >
              <RefreshCw size={14} />
              刷新
            </Button>
            <Button
              className="project-batch-toggle"
              variant="outline"
              disabled={busy || (!materials.length && !batch)}
              onClick={() => {
                setBatch((value) => !value);
                setSelected([]);
              }}
            >
              {batch ? "退出批量" : "批量处理"}
            </Button>
          </div>
          {batch && (
            <div className="project-batch-bar">
              <label>
                <input
                  type="checkbox"
                  disabled={busy || !materials.length}
                  checked={
                    materials.length > 0 && selected.length === materials.length
                  }
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? materials.map((item) => item.id)
                        : [],
                    )
                  }
                />
                全选
              </label>
              <span>已选 {selected.length} 项</span>
              <Button
                size="sm"
                variant="outline"
                data-delete-action
                disabled={busy || !selected.length}
                onClick={() => setConfirmBatch(true)}
              >
                <Trash2 size={14} />
                批量移除
              </Button>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <div className="project-library-list">
            {loadingLibrary && !materials.length && (
              <p role="status">正在读取项目资料…</p>
            )}
            {materials.map((item) => (
              <article className="project-material-item" key={item.id}>
                {batch && (
                  <input
                    type="checkbox"
                    className="project-material-selection"
                    aria-label={`选择 ${item.name}`}
                    checked={selected.includes(item.id)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelected((ids) =>
                        event.target.checked
                          ? [...ids, item.id]
                          : ids.filter((id) => id !== item.id),
                      )
                    }
                  />
                )}
                <div className="project-material-content">
                  {item.image ? (
                    <div className="project-image-material">
                      <Picture id={item.file_id} name={item.name} />
                      <span>{item.name}</span>
                      <MaterialState item={item} />
                      {removeAction(item)}
                    </div>
                  ) : (
                    <FileCard
                      file={{ id: item.file_id, name: item.name }}
                      upload
                      status={<MaterialState item={item} />}
                      trailingAction={removeAction(item)}
                    />
                  )}
                </div>
              </article>
            ))}
            {!loadingLibrary && !materials.length && !error && (
              <p className="sidebar-empty">还没有共享资料。</p>
            )}
          </div>
          {sourceError && <p role="status">{sourceError}</p>}
          {sources.length > 0 && (
            <section className="project-source-files"><h2>从当前聊天加入资料</h2>
              {sources.map((item) => (
                <div key={item.id}>
                  <span>{item.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (!library) return;
                      const project = library;
                      void mutate(async () => {
                        await api(`/projects/${project.id}/materials`, "POST", {
                          file_id: item.id,
                          conversation_id: currentId,
                        });
                        setSources((items) => items.filter((source) => source.id !== item.id));
                        await loadLibrary(project);
                        onLibraryChange?.();
                      });
                    }}
                  >
                    加入项目资料
                  </Button>
                </div>
              ))}
            </section>
          )}
          </div>
      </section>}
      <ConfirmDelete
        open={confirmBatch}
        title={`移除选中的 ${selected.length} 项资料？`}
        description="仅移除当前项目中的资料副本。原聊天附件、本地源文件和其他项目资料不会删除。"
        label="移除所选资料"
        error={error}
        onClose={() => {
          if (!busy) setConfirmBatch(false);
        }}
        onConfirm={() => remove(selected)}
      />
    </>
  );
}
