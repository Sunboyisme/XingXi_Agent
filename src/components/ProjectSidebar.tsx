import { SoftSelect } from "./ui/soft-select";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ChevronDown,
  Folder,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  SquarePen,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { api, type Conversation, type Project } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import type { ProjectManagementRequest } from "./ProjectManagement";
import { Hint } from "./common";
import { errorMessage, keepIfSame } from "@/lib/utils";
import { DeleteConversationButton } from "./DeleteConversationButton";

type SearchHit = {
  conversation_id: string;
  message_id: string | null;
  title: string;
  snippet: string;
  project_name: string;
};

function ConversationTitle({ title }: { title: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  useEffect(() => {
    const container = viewport.current;
    const content = text.current;
    if (!container || !content) return;
    const measure = () => {
      const next = Math.max(0, content.scrollWidth - container.clientWidth);
      setDistance((previous) => (previous === next ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [title]);
  return (
    <span
      ref={viewport}
      className="conversation-title"
      data-overflow={distance > 1 || undefined}
      style={
        {
          "--conversation-title-offset": `${-distance}px`,
          "--conversation-title-duration": `${Math.max(4, distance / 34 + 3)}s`,
        } as CSSProperties
      }
    >
      <span ref={text} className="conversation-title-text">
        {title}
      </span>
    </span>
  );
}

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
        {running > 0 && (
          // Always visible: a collapsed group must still show work in progress.
          <span
            className="sidebar-running"
            role="status"
            aria-label={`${label}中有 ${running} 个对话正在进行`}
          >
            <i aria-hidden="true" />
            {running}
          </span>
        )}
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
  onManage,
}: {
  conversations: Conversation[];
  projects: Project[];
  currentId: string | null;
  projectId: string | null;
  onNew: (id: string | null, pinned?: boolean) => void;
  onProject: (id: string) => void;
  onOpen: (conversation: Conversation, messageId?: string | null) => void;
  onDelete: (conversation: Conversation) => Promise<void>;
  refresh: () => Promise<void>;
  visible?: boolean;
  onManage: (request: ProjectManagementRequest) => void;
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
          if (live) setActivity(keepIfSame(values));
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
    // A finished reply refreshes the conversation list; re-check activity at once.
  }, [visible, conversations]);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [conversationName, setConversationName] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropProject, setDropProject] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const searchSequence = useRef(0);
  const mutationLock = useRef(false);
  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const selectedConversation = useRef(currentId);
  selectedConversation.current = currentId;

  function manage(
    action: ProjectManagementRequest["action"],
    id: string | null = null,
  ) {
    const next = { id, action, key: Date.now() + Math.random() };
    onManage(next);
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
          : errorMessage(cause),
      );
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  function dragTarget(x: number, y: number) {
    return (
      document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-project-drop]")?.dataset.projectDrop ||
      null
    );
  }
  function finishDrag(x: number, y: number) {
    const value = drag.current;
    drag.current = null;
    setDraggingId(null);
    setDropProject(null);
    if (!value?.active) return;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    const target = dragTarget(x, y);
    const source = conversations.find((item) => item.id === value.id);
    if (
      !target ||
      !source ||
      source.project_id === target ||
      busy ||
      activity[value.id]
    )
      return;
    void mutate(async () => {
      const moved = await api<Conversation>(
        `/conversations/${value.id}`,
        "PATCH",
        { project_id: target },
      );
      if (selectedConversation.current === value.id) onOpen(moved);
      setCollapsed((ids) => ids.filter((key) => key !== target));
    });
  }
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
      if (sequence === searchSequence.current) setError(errorMessage(cause));
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
          style={{ touchAction: "pan-y" }}
          onPointerDown={(event) => {
            if (event.button !== 0 || busy || activity[value.id]) return;
            drag.current = {
              id: value.id,
              x: event.clientX,
              y: event.clientY,
              active: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const own = drag.current;
            if (!own || own.id !== value.id) return;
            if (
              !own.active &&
              Math.hypot(event.clientX - own.x, event.clientY - own.y) < 7
            )
              return;
            own.active = true;
            event.preventDefault();
            setDraggingId(value.id);
            const target = dragTarget(event.clientX, event.clientY);
            setDropProject(
              target && value.project_id !== target ? target : null,
            );
          }}
          onPointerUp={(event) => finishDrag(event.clientX, event.clientY)}
          onPointerCancel={() => {
            drag.current = null;
            setDraggingId(null);
            setDropProject(null);
          }}
          onClick={() => {
            if (!suppressClick.current) onOpen(value);
          }}
          onDoubleClick={() => {
            setConversationName(value.title);
            setRenaming(value);
          }}
        >
          {value.pinned_at && (
            <Pin
              className="conversation-pin-marker"
              size={13}
              aria-hidden="true"
            />
          )}
          <ConversationTitle title={value.title} />
          {Boolean(activity[value.id]) && (
            <span
              className="sidebar-running is-row"
              role="status"
              aria-label="正在进行"
            >
              <i aria-hidden="true" />
            </span>
          )}
        </button>
        <div className="conversation-row-actions">
          <Hint label={value.pinned_at ? "取消置顶" : "置顶对话"}>
            <button
              type="button"
              className="conversation-pin"
              aria-label={`${value.pinned_at ? "取消置顶对话" : "置顶对话"} ${value.title}`}
              aria-pressed={Boolean(value.pinned_at)}
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
          </Hint>
          <DeleteConversationButton
            conversation={value}
            disabled={busy}
            onDelete={onDelete}
          />
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
      <Button
        variant="ghost"
        className="new-chat-button"
        aria-label="新聊天"
        onClick={() => onNew(projectId)}
      >
        <SquarePen size={16} className="size-4" aria-hidden="true" />
        <span className="new-chat-button-label">新聊天</span>
      </Button>
      <div className="conversation-sidebar project-conversations">
        {error && !searchOpen && !renaming && (
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
          onNew={() => manage("create")}
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
                data-project-drop={project.id}
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
                        <DropdownMenu.Item
                          onSelect={() => manage("settings", project.id)}
                        >
                          项目名称与说明
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() => manage("library", project.id)}
                        >
                          项目资料库
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="danger"
                          onSelect={() => manage("delete", project.id)}
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
          label="最近"
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
            <SoftSelect
              label="搜索范围"
              value={scope}
              onValueChange={setScope}
              options={[
                { value: "all", label: "全部聊天" },
                { value: "unfiled", label: "未加入项目" },
                ...projects.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ]}
            />
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
