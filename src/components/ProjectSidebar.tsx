import { useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  ChevronDown,
  CircleDot,
  Folder,
  FolderOpen,
  MessageCircle,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { api, fetchApi, type Conversation, type Project } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { ConfirmDelete } from "./common";
import { FileCard } from "./OfficeFiles";
import { Picture } from "./ImageAttachments";

type Material = {
  id: string;
  file_id: string;
  name: string;
  image: boolean;
  file_status: string;
  error: string;
};
type Source = { id: string; name: string; kind: string };
type SearchHit = {
  conversation_id: string;
  message_id: string | null;
  title: string;
  snippet: string;
  project_name: string;
};

export type ProjectPanelRequest = {
  id: string;
  action: "library" | "settings";
  key: number;
};

function GroupHeading({
  label,
  count,
  collapsed,
  controls,
  onToggle,
  onNew,
  newLabel,
  running,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  controls: string;
  onToggle: () => void;
  onNew: () => void;
  newLabel: string;
  running: number;
}) {
  return (
    <div className="sidebar-section-heading">
      <button
        className="sidebar-group-toggle"
        aria-expanded={!collapsed}
        aria-controls={controls}
        onClick={onToggle}
      >
        <ChevronDown size={13} data-collapsed={collapsed} />
        <span>{label}</span>
        <small>{count}</small>
      </button>
      <div className="sidebar-section-actions">
        <Button
          size="icon"
          variant="ghost"
          aria-label={newLabel}
          onClick={onNew}
        >
          <Plus size={15} />
        </Button>
        {running > 0 && (
          <span
            className="project-running-state"
            data-active="true"
            role="img"
            aria-label={`${label}中有 ${running} 个任务正在运行`}
            title={`${running} 个任务进行中`}
          >
            <CircleDot size={15} />
          </span>
        )}
      </div>
    </div>
  );
}

export function ProjectSidebar({
  conversations,
  projects,
  currentId,
  projectId,
  onNew,
  onProject,
  onOpen,
  onDelete,
  refresh,
  visible = true,
  request,
  onLibraryChange,
}: {
  conversations: Conversation[];
  projects: Project[];
  currentId: string | null;
  projectId: string | null;
  onNew: (id: string | null, pinned?: boolean) => void;
  onProject: (id: string) => void;
  onOpen: (conversation: Conversation, messageId?: string | null) => void;
  onDelete: (conversation: Conversation) => void;
  refresh: () => Promise<void>;
  visible?: boolean;
  request?: ProjectPanelRequest | null;
  onLibraryChange?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const value = JSON.parse(
        localStorage.getItem("bai-sidebar-folds") || "[]",
      );
      return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("bai-sidebar-folds", JSON.stringify(collapsed));
    } catch {
      /* Storage must not block navigation. */
    }
  }, [collapsed]);
  function toggleSection(key: string) {
    setCollapsed((ids) =>
      ids.includes(key) ? ids.filter((id) => id !== key) : [...ids, key],
    );
  }
  const [activity, setActivity] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!visible || !conversations.length) return;
    let live = true;
    let timer = 0;
    async function poll() {
      if (!document.hidden) {
        try {
          const values = await api<Record<string, number>>(
            "/conversations/activity",
          );
          if (live)
            setActivity((current) =>
              JSON.stringify(current) === JSON.stringify(values)
                ? current
                : values,
            );
        } catch {
          /* Keep the last known state during a transient connection failure. */
        }
      }
      if (live) timer = window.setTimeout(() => void poll(), 5000);
    }
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [visible, conversations.length]);
  const [editing, setEditing] = useState<Project | null | undefined>();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [conversationName, setConversationName] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropProject, setDropProject] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [library, setLibrary] = useState<Project | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const librarySequence = useRef(0);
  const searchSequence = useRef(0);
  const mutationLock = useRef(false);
  const workspacePicker = useRef<symbol | null>(null);
  const editorSequence = useRef(0);
  const native = isTauri();
  const current = conversations.find((item) => item.id === currentId);
  const selectedConversation = useRef(currentId);
  selectedConversation.current = currentId;

  useEffect(
    () => () => {
      editorSequence.current += 1;
      workspacePicker.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!request) return;
    const project = projects.find((item) => item.id === request.id);
    if (!project) return;
    setError("");
    if (request.action === "library") setLibrary(project);
    else edit(project);
    // A request is an explicit open action; refreshing project data must not reopen a closed dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  function edit(project: Project | null) {
    editorSequence.current += 1;
    setError("");
    setName(project?.name || "");
    setInstructions(project?.instructions || "");
    setWorkspacePath(project?.workspace_path || "");
    setEditing(project);
  }
  function closeEditor() {
    editorSequence.current += 1;
    setEditing(undefined);
  }
  async function chooseWorkspace() {
    if (
      !native ||
      editing === undefined ||
      mutationLock.current ||
      workspacePicker.current
    )
      return;
    const sequence = editorSequence.current;
    const picker = Symbol();
    workspacePicker.current = picker;
    setPickingWorkspace(true);
    setError("");
    try {
      const path = await invoke<string | null>("pick_project_workspace", {
        initialPath: workspacePath || null,
      });
      if (sequence === editorSequence.current && path !== null)
        setWorkspacePath(path);
    } catch (cause) {
      if (sequence === editorSequence.current)
        setError(
          `无法选择文件夹：${cause instanceof Error ? cause.message : String(cause)}`,
        );
    } finally {
      if (workspacePicker.current === picker) {
        workspacePicker.current = null;
        setPickingWorkspace(false);
      }
    }
  }
  async function mutate(operation: () => Promise<unknown>) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    setError("");
    let applied = false;
    try {
      await operation();
      applied = true;
      if (library) onLibraryChange?.();
      await refresh();
    } catch (cause) {
      setError(
        applied
          ? "修改已保存，列表暂未刷新，请稍后重试刷新。"
          : (cause as Error).message,
      );
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function loadLibrary(project: Project) {
    const sequence = ++librarySequence.current;
    try {
      const [files, inputs] = await Promise.all([
        api<Material[]>(`/projects/${project.id}/materials`),
        current?.project_id === project.id
          ? api<Source[]>(`/conversations/${current.id}/files`)
          : Promise.resolve([]),
      ]);
      if (sequence === librarySequence.current) {
        setMaterials(files);
        setSources(inputs.filter((item) => !item.kind.startsWith("project_")));
      }
    } catch (cause) {
      if (sequence === librarySequence.current)
        setError((cause as Error).message);
    }
  }
  useEffect(() => {
    if (!library) return;
    setMaterials([]);
    setSources([]);
    setError("");
    void loadLibrary(library);
    return () => {
      librarySequence.current += 1;
    };
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
  }, [materials, library]);
  async function search(offset = 0) {
    const sequence = ++searchSequence.current;
    if (!query.trim()) {
      setResults([]);
      setNext(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const project =
        scope === "all"
          ? ""
          : `&project_id=${encodeURIComponent(scope === "unfiled" ? "" : scope)}`;
      const value = await api<{
        items: SearchHit[];
        next_offset: number | null;
      }>(
        `/conversations/search?q=${encodeURIComponent(query.trim())}${project}&offset=${offset}`,
      );
      if (sequence === searchSequence.current) {
        setResults((items) =>
          offset ? [...items, ...value.items] : value.items,
        );
        setNext(value.next_offset);
      }
    } catch (cause) {
      if (sequence === searchSequence.current)
        setError((cause as Error).message);
    } finally {
      if (sequence === searchSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!searchOpen) return;
    setResults([]);
    setNext(null);
    const timer = window.setTimeout(() => void search(), 250);
    return () => {
      clearTimeout(timer);
      searchSequence.current += 1;
    };
  }, [query, scope, searchOpen]);

  function row(value: Conversation) {
    return (
      <div
        className={`conversation-link ${currentId === value.id ? "selected" : ""}`}
        key={value.id}
        data-dragging={draggingId === value.id}
      >
        <button
          type="button"
          aria-label={`打开对话 ${value.title}`}
          aria-current={currentId === value.id ? "page" : undefined}
          title={`${value.title}（双击重命名）`}
          draggable={!busy && !activity[value.id]}
          onDragStart={(event) => {
            if (busy || activity[value.id]) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.setData(
              "application/x-xiaoxi-conversation",
              value.id,
            );
            event.dataTransfer.effectAllowed = "move";
            setDraggingId(value.id);
          }}
          onDragEnd={() => {
            setDraggingId(null);
            setDropProject(null);
          }}
          onClick={() => onOpen(value)}
          onDoubleClick={() => {
            setConversationName(value.title);
            setRenaming(value);
          }}
        >
          {value.pinned_at ? <Pin size={13} /> : <MessageCircle size={14} />}
          <span>{value.title}</span>
        </button>
        <div className="conversation-row-actions">
          <button
            type="button"
            className="conversation-pin"
            aria-label={`${value.pinned_at ? "取消置顶对话" : "置顶对话"} ${value.title}`}
            aria-pressed={Boolean(value.pinned_at)}
            title={value.pinned_at ? "取消置顶" : "置顶对话"}
            disabled={busy}
            onClick={() =>
              void mutate(() =>
                api(`/conversations/${value.id}`, "PATCH", {
                  pinned: !value.pinned_at,
                }),
              )
            }
          >
            {value.pinned_at ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
          <button
            type="button"
            className="conversation-delete"
            aria-label={`删除对话 ${value.title}`}
            title="删除对话"
            disabled={busy}
            onClick={() => {
              if (!mutationLock.current) onDelete(value);
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    );
  }
  const grouped = useMemo(() => {
    const pinned = conversations
      .filter((item) => item.pinned_at)
      .sort((a, b) => a.pinned_at!.localeCompare(b.pinned_at!));
    const byProject = new Map<string, Conversation[]>();
    for (const item of conversations) {
      const key = item.project_id || "";
      const values = byProject.get(key) || [];
      values.push(item);
      byProject.set(key, values);
    }
    return { pinned, byProject, ordinary: byProject.get("") || [] };
  }, [conversations]);
  const pinned = grouped.pinned;
  const runningIn = (items: Conversation[]) =>
    items.reduce((total, item) => total + (activity[item.id] || 0), 0);
  const runningCount = runningIn(
    conversations.filter((item) => item.project_id),
  );
  return (
    <>
      <div className="chat-sidebar-heading">
        <button className="brand-home" onClick={() => onNew(null)}>
          <strong>XiaoXi</strong>
          <span>你的个人 AI 助手</span>
        </button>
      </div>
      <Button className="new-chat-button" onClick={() => onNew(projectId)}>
        <Plus size={16} />
        新聊天
      </Button>
      <button
        type="button"
        className="sidebar-search-trigger"
        aria-label="搜索聊天"
        onClick={() => {
          setScope(projectId || "all");
          setError("");
          setSearchOpen(true);
        }}
      >
        <Search size={16} aria-hidden="true" />
        <span>搜索对话…</span>
      </button>
      <div className="conversation-sidebar project-conversations">
        {error &&
          editing === undefined &&
          !library &&
          !searchOpen &&
          !renaming && (
            <p className="sidebar-error" role="alert">
              {error}
            </p>
          )}
        <section>
          <GroupHeading
            label="置顶"
            count={pinned.length}
            collapsed={collapsed.includes("group:pinned")}
            controls="sidebar-pinned-list"
            onToggle={() => toggleSection("group:pinned")}
            onNew={() => onNew(null, true)}
            newLabel="新建置顶对话"
            running={runningIn(pinned)}
          />
          <div
            id="sidebar-pinned-list"
            hidden={collapsed.includes("group:pinned")}
          >
            {pinned.map(row)}
            {!pinned.length && <p className="sidebar-empty">暂无置顶对话</p>}
          </div>
        </section>
        <GroupHeading
          label="项目"
          count={projects.length}
          collapsed={collapsed.includes("group:projects")}
          controls="sidebar-projects-list"
          onToggle={() => toggleSection("group:projects")}
          onNew={() => edit(null)}
          newLabel="新建项目"
          running={runningCount}
        />
        {!collapsed.includes("group:projects") && (
          <div id="sidebar-projects-list">
            {projects.map((project) => (
              <section
                key={project.id}
                className="sidebar-project"
                data-selected={projectId === project.id}
                data-drop-target={dropProject === project.id}
                onDragOver={(event) => {
                  if (
                    !draggingId ||
                    busy ||
                    activity[draggingId] ||
                    !event.dataTransfer.types.includes(
                      "application/x-xiaoxi-conversation",
                    )
                  )
                    return;
                  const source = conversations.find(
                    (item) => item.id === draggingId,
                  );
                  if (!source || source.project_id === project.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropProject(project.id);
                }}
                onDragLeave={(event) => {
                  if (
                    !(event.relatedTarget instanceof Node) ||
                    !event.currentTarget.contains(event.relatedTarget)
                  )
                    setDropProject(null);
                }}
                onDrop={(event) => {
                  const id = event.dataTransfer.getData(
                    "application/x-xiaoxi-conversation",
                  );
                  if (!id || id !== draggingId) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setDraggingId(null);
                  setDropProject(null);
                  if (
                    busy ||
                    activity[id] ||
                    conversations.find((item) => item.id === id)?.project_id ===
                      project.id
                  )
                    return;
                  void mutate(async () => {
                    const moved = await api<Conversation>(
                      `/conversations/${id}`,
                      "PATCH",
                      { project_id: project.id },
                    );
                    if (selectedConversation.current === id) onOpen(moved);
                    setCollapsed((ids) =>
                      ids.filter((key) => key !== project.id),
                    );
                  });
                }}
              >
                <div className="project-heading">
                  <button
                    className="project-collapse"
                    aria-label={`${collapsed.includes(project.id) ? "展开" : "收起"}项目 ${project.name}`}
                    aria-expanded={!collapsed.includes(project.id)}
                    onClick={() =>
                      setCollapsed((ids) =>
                        ids.includes(project.id)
                          ? ids.filter((id) => id !== project.id)
                          : [...ids, project.id],
                      )
                    }
                  >
                    <ChevronDown
                      size={13}
                      style={{
                        transform: collapsed.includes(project.id)
                          ? "rotate(-90deg)"
                          : undefined,
                      }}
                    />
                  </button>
                  <button
                    className="project-name"
                    aria-label={`打开项目 ${project.name}`}
                    onClick={() => onProject(project.id)}
                  >
                    <Folder size={14} />
                    <span>{project.name}</span>
                    <small className="project-chat-count">
                      {(grouped.byProject.get(project.id) || []).length}
                    </small>
                  </button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button aria-label={`管理项目 ${project.name}`}>
                        <MoreHorizontal size={15} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="project-menu"
                        side="right"
                      >
                        <DropdownMenu.Item onSelect={() => onNew(project.id)}>
                          新建项目聊天
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onSelect={() => edit(project)}>
                          项目名称与说明
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() => {
                            setError("");
                            setLibrary(project);
                          }}
                        >
                          项目资料库
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="danger"
                          onSelect={() => {
                            setError("");
                            setDeleting(project);
                          }}
                        >
                          删除项目
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
                {!collapsed.includes(project.id) && (
                  <div className="project-chat-list">
                    {(grouped.byProject.get(project.id) || []).map(row)}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
        <GroupHeading
          label="对话"
          count={grouped.ordinary.length}
          collapsed={collapsed.includes("group:ordinary")}
          controls="sidebar-ordinary-list"
          onToggle={() => toggleSection("group:ordinary")}
          onNew={() => onNew(null)}
          newLabel="新建对话"
          running={runningIn(grouped.ordinary)}
        />
        {!collapsed.includes("group:ordinary") && (
          <div id="sidebar-ordinary-list">{grouped.ordinary.map(row)}</div>
        )}
        {!conversations.length && <p className="sidebar-empty">暂无聊天</p>}
      </div>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) closeEditor();
        }}
      >
        <DialogContent className="project-editor">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑项目" : "新建项目"}</DialogTitle>
            <DialogDescription>
              同项目聊天可按需检索；附件和成果显式加入资料库后才共享。
            </DialogDescription>
          </DialogHeader>
          <label>
            项目名称
            <Input
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            项目说明
            <Textarea
              value={instructions}
              maxLength={12000}
              rows={6}
              placeholder="项目目标、背景和回答要求…"
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <div className="project-workspace-field" aria-busy={pickingWorkspace}>
            <label htmlFor="project-workspace">本地工作路径</label>
            <Input
              id="project-workspace"
              value={workspacePath}
              readOnly
              title={workspacePath || "尚未选择文件夹"}
              placeholder="尚未选择文件夹"
              aria-describedby="project-workspace-hint"
            />
            <div className="project-workspace-actions">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!native || busy || pickingWorkspace}
                onClick={() => void chooseWorkspace()}
              >
                <FolderOpen size={14} />
                {pickingWorkspace
                  ? "正在选择…"
                  : workspacePath
                    ? "更换文件夹"
                    : "选择文件夹"}
              </Button>
              {workspacePath && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || pickingWorkspace}
                  onClick={() => setWorkspacePath("")}
                >
                  清除
                </Button>
              )}
            </div>
            <small id="project-workspace-hint" className="project-workspace-hint">
              {native
                ? "可选。此项目内的对话可以只读扫描、读取该文件夹；清除后保存可取消访问。"
                : "请在桌面端选择本地文件夹；此项目内的对话可以只读扫描、读取，清除后保存可取消访问。"}
            </small>
          </div>
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={closeEditor}
            >
              取消
            </Button>
            <Button
              disabled={busy || pickingWorkspace || !name.trim()}
              onClick={() => {
                if (workspacePicker.current) return;
                void mutate(async () => {
                  const saved = await api<Project>(
                    editing ? `/projects/${editing.id}` : "/projects",
                    editing ? "PUT" : "POST",
                    {
                      name: name.trim(),
                      instructions,
                      workspace_path: workspacePath.trim(),
                    },
                  );
                  closeEditor();
                  if (!editing) onProject(saved.id);
                });
              }}
            >
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(renaming)}
        onOpenChange={(open) => {
          if (!open && !busy) setRenaming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
            <DialogDescription>
              为这段对话取一个便于查找的名称。
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!renaming || !conversationName.trim() || busy) return;
              const selected = renaming;
              void mutate(async () => {
                const updated = await api<Conversation>(
                  `/conversations/${selected.id}`,
                  "PATCH",
                  { title: conversationName.trim() },
                );
                if (selectedConversation.current === selected.id)
                  onOpen(updated);
                setRenaming(null);
              });
            }}
          >
            <label>
              对话名称
              <Input
                autoFocus
                value={conversationName}
                maxLength={200}
                onChange={(event) => setConversationName(event.target.value)}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setRenaming(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy || !conversationName.trim()}>
                保存名称
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        open={Boolean(deleting)}
        title="删除这个项目？"
        description="聊天会移回未加入项目的对话列表；项目专属资料副本和项目记忆会删除，原聊天附件和成果保留。"
        label="删除项目"
        error={error}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting || busy) return;
          await mutate(async () => {
            await api(`/projects/${deleting.id}`, "DELETE");
            if (projectId === deleting.id) onNew(null);
            setDeleting(null);
          });
        }}
      />
      <Dialog
        open={Boolean(library)}
        onOpenChange={(open) => {
          if (!open && !busy) setLibrary(null);
        }}
      >
        <DialogContent className="project-library">
          <DialogHeader>
            <DialogTitle>{library?.name} · 项目资料</DialogTitle>
            <DialogDescription>
              保存独立副本，同项目聊天可读取；删除原聊天不会删除这里的资料。
            </DialogDescription>
          </DialogHeader>
          <div className="project-library-actions">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept=".png,.jpg,.jpeg,.webp,.gif,.docx,.pdf,.xlsx,.txt,.md,.csv,.json"
              onChange={async (event) => {
                const files = [...(event.target.files || [])];
                event.target.value = "";
                if (!library || !files.length) return;
                const selected = library;
                await mutate(async () => {
                  try {
                    for (const file of files) {
                      const body = new FormData();
                      body.append("file", file);
                      await fetchApi(
                        `/projects/${selected.id}/materials/upload`,
                        { method: "POST", body },
                      );
                    }
                  } finally {
                    await loadLibrary(selected);
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
              刷新
            </Button>
          </div>
          {error && <p role="alert">{error}</p>}
          <div className="project-library-list">
            {materials.map((item) => (
              <article key={item.id}>
                {item.image ? (
                  <div className="project-image-material">
                    <Picture id={item.file_id} name={item.name} />
                    <span>{item.name}</span>
                  </div>
                ) : (
                  <FileCard
                    file={{ id: item.file_id, name: item.name }}
                    upload
                  />
                )}
                <div className="project-material-meta">
                  <span>
                    {item.file_status === "ready"
                      ? "可用"
                      : item.file_status === "partial"
                        ? "部分可读"
                        : item.file_status === "failed"
                          ? item.error
                          : "正在解析…"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`移除项目资料 ${item.name}`}
                    onClick={() =>
                      void mutate(async () => {
                        await api(
                          `/projects/${library!.id}/materials/${item.id}`,
                          "DELETE",
                        );
                        await loadLibrary(library!);
                      })
                    }
                  >
                    <Trash2 size={13} />
                    移除
                  </Button>
                </div>
              </article>
            ))}
            {!materials.length && (
              <p className="sidebar-empty">还没有共享资料。</p>
            )}
          </div>
          {sources.length > 0 && (
            <details className="project-source-files">
              <summary>
                <FolderOpen size={14} />
                从当前聊天加入
              </summary>
              {sources.map((item) => (
                <div key={item.id}>
                  <span>{item.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void mutate(async () => {
                        await api(
                          `/projects/${library!.id}/materials`,
                          "POST",
                          { file_id: item.id, conversation_id: currentId },
                        );
                        await loadLibrary(library!);
                      })
                    }
                  >
                    加入项目资料
                  </Button>
                </div>
              ))}
            </details>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="chat-search-dialog">
          <DialogHeader>
            <DialogTitle>搜索聊天</DialogTitle>
            <DialogDescription>
              查找标题与消息正文，点击结果跳到对应消息。
            </DialogDescription>
          </DialogHeader>
          <div className="chat-search-fields">
            <Input
              autoFocus
              value={query}
              maxLength={200}
              placeholder="输入关键词…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="搜索范围"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="all">全部聊天</option>
              <option value="unfiled">未加入项目</option>
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          {error && <p role="alert">{error}</p>}
          <div className="chat-search-results" aria-busy={loading}>
            {results.map((hit) => (
              <button
                key={hit.conversation_id}
                onClick={() => {
                  const conversation = conversations.find(
                    (item) => item.id === hit.conversation_id,
                  );
                  if (conversation) {
                    onOpen(conversation, hit.message_id);
                    setSearchOpen(false);
                  }
                }}
              >
                <strong>{hit.title}</strong>
                <small>{hit.project_name}</small>
                <p>{hit.snippet}</p>
              </button>
            ))}
            {!results.length && (
              <p>
                {loading
                  ? "搜索中…"
                  : query.trim()
                    ? "没有找到匹配的聊天。"
                    : "输入关键词开始搜索。"}
              </p>
            )}
            {next !== null && (
              <Button
                variant="ghost"
                disabled={loading}
                onClick={() => void search(next)}
              >
                继续加载
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
