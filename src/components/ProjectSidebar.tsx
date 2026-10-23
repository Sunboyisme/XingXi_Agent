import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Folder,
  FolderOpen,
  MessageCircle,
  MoreHorizontal,
  Pin,
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

export function ProjectSidebar({
  conversations,
  projects,
  currentId,
  projectId,
  onNew,
  onOpen,
  onDelete,
  refresh,
}: {
  conversations: Conversation[];
  projects: Project[];
  currentId: string | null;
  projectId: string | null;
  onNew: (id: string | null) => void;
  onOpen: (conversation: Conversation, messageId?: string | null) => void;
  onDelete: (conversation: Conversation) => void;
  refresh: () => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [editing, setEditing] = useState<Project | null | undefined>();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
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
  const current = conversations.find((item) => item.id === currentId);

  function edit(project: Project | null) {
    setError("");
    setName(project?.name || "");
    setInstructions(project?.instructions || "");
    setEditing(project);
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
      >
        <button
          aria-label={`打开对话 ${value.title}`}
          aria-current={currentId === value.id ? "page" : undefined}
          onClick={() => onOpen(value)}
        >
          {value.pinned_at ? <Pin size={13} /> : <MessageCircle size={14} />}
          <span>{value.title}</span>
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button aria-label={`管理对话 ${value.title}`}>
              <MoreHorizontal size={15} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="project-menu"
              side="right"
              align="start"
            >
              <DropdownMenu.Item
                disabled={busy}
                onSelect={() =>
                  void mutate(() =>
                    api(`/conversations/${value.id}`, "PATCH", {
                      pinned: !value.pinned_at,
                    }),
                  )
                }
              >
                {value.pinned_at ? "取消置顶" : "置顶聊天"}
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger>移到项目</DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent className="project-menu">
                    {[{ id: "", name: "普通聊天" }, ...projects].map(
                      (project) => (
                        <DropdownMenu.Item
                          key={project.id}
                          disabled={
                            busy || (value.project_id || "") === project.id
                          }
                          onSelect={() =>
                            void mutate(async () => {
                              const moved = await api<Conversation>(
                                `/conversations/${value.id}`,
                                "PATCH",
                                { project_id: project.id || null },
                              );
                              if (currentId === value.id) onOpen(moved);
                            })
                          }
                        >
                          {project.name}
                        </DropdownMenu.Item>
                      ),
                    )}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
              <DropdownMenu.Item
                className="danger"
                onSelect={() => onDelete(value)}
              >
                删除聊天
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    );
  }
  const pinned = conversations
    .filter((item) => item.pinned_at)
    .sort((a, b) => a.pinned_at!.localeCompare(b.pinned_at!));
  return (
    <>
      <div className="chat-sidebar-heading">
        <button className="brand-home" onClick={() => onNew(null)}>
          <strong>XiaoXi</strong>
        </button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="搜索聊天"
          onClick={() => {
            setScope(projectId || "all");
            setError("");
            setSearchOpen(true);
          }}
        >
          <Search size={17} />
        </Button>
      </div>
      <Button className="new-chat-button" onClick={() => onNew(projectId)}>
        <Plus size={16} />
        新聊天
      </Button>
      <div className="conversation-sidebar project-conversations">
        {error && editing === undefined && !library && !searchOpen && (
          <p className="sidebar-error" role="alert">
            {error}
          </p>
        )}
        {pinned.length > 0 && (
          <section>
            <p className="sidebar-label">
              置顶 <span>{pinned.length}</span>
            </p>
            {pinned.map(row)}
          </section>
        )}
        <div className="project-section-heading">
          <span>项目</span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="新建项目"
            onClick={() => edit(null)}
          >
            <Plus size={15} />
          </Button>
        </div>
        {projects.map((project) => (
          <section
            key={project.id}
            className="sidebar-project"
            data-selected={projectId === project.id}
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
                onClick={() => onNew(project.id)}
              >
                <Folder size={14} />
                <span>{project.name}</span>
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button aria-label={`管理项目 ${project.name}`}>
                    <MoreHorizontal size={15} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="project-menu" side="right">
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
                {conversations
                  .filter(
                    (item) => item.project_id === project.id && !item.pinned_at,
                  )
                  .map(row)}
              </div>
            )}
          </section>
        ))}
        <button
          className="sidebar-label sidebar-unfiled"
          onClick={() => onNew(null)}
        >
          普通聊天{" "}
          <span>{conversations.filter((item) => !item.project_id).length}</span>
        </button>
        {conversations
          .filter((item) => !item.project_id && !item.pinned_at)
          .map(row)}
        {!conversations.length && <p className="sidebar-empty">暂无聊天</p>}
      </div>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(undefined);
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
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              取消
            </Button>
            <Button
              disabled={busy || !name.trim()}
              onClick={() =>
                void mutate(async () => {
                  const saved = await api<Project>(
                    editing ? `/projects/${editing.id}` : "/projects",
                    editing ? "PUT" : "POST",
                    { name: name.trim(), instructions },
                  );
                  setEditing(undefined);
                  if (!editing) onNew(saved.id);
                })
              }
            >
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        open={Boolean(deleting)}
        title="删除这个项目？"
        description="聊天会移回普通聊天；项目专属资料副本和项目记忆会删除，原聊天附件和成果保留。"
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
              <option value="unfiled">普通聊天</option>
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
