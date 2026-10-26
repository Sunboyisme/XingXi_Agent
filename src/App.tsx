import { flushLearningDrafts } from "@/lib/learningLifecycle";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Bell,
  LibraryBig,
  Calendar,
  BookOpen,
  CircleHelp,
  Loader2,
  MessageCircle,
  Folder,
  Settings2,
  X,
} from "lucide-react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useGeneralPreferences } from "@/lib/generalPreferences";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Tooltip } from "radix-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  api,
  type Settings,
  type Conversation,
  type Project,
  type Goal,
  type Memory,
  type Notification,
} from "@/lib/api";
const CalendarPage = lazy(() =>
  import("./components/CalendarPage").then((module) => ({
    default: module.CalendarPage,
  })),
);
import { ChatPage } from "./components/ChatPage";
const LearningPage = lazy(() =>
  import("./components/LearningPage").then((module) => ({
    default: module.LearningPage,
  })),
);
import { NotificationsPanel } from "./components/NotificationsPanel";
import type { SettingsTab } from "./components/SettingsPage";
import type { ModelContextTarget } from "./components/ModelConnections";
const SettingsPage = lazy(() =>
  import("./components/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
import { ConfirmDelete, ErrorNotice, Toast } from "./components/common";
import { BaiAvatar } from "./components/BaiAvatar";
import { WindowFrame } from "./components/WindowFrame";
import { SidebarResize } from "./components/SidebarResize";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ProjectOverview } from "./components/ProjectOverview";
import { ProjectsPage } from "./components/ProjectsPage";
import { NavigationOverflowMenu, type NavigationFeatureItem } from "./components/NavigationOverflowMenu";
import { ProjectManagement, type ProjectManagementRequest } from "./components/ProjectManagement";

type Page = "chat" | "projects" | "learning" | "plans" | "knowledge" | "settings";
const KnowledgePage = lazy(() => import("./components/KnowledgePage").then((module) => ({ default: module.KnowledgePage })));
import type { KnowledgeSource } from "./components/KnowledgeSources";
const featurePages: NavigationFeatureItem[] = [
  {
    id: "projects",
    label: "项目",
    icon: Folder,
  },
  {
    id: "learning",
    label: "学习",
    icon: BookOpen,
  },
  {
    id: "plans",
    label: "计划",
    icon: Calendar,
  },
  { id: "knowledge", label: "知识库", icon: LibraryBig },
];
const pages = [{ id: "chat" as const, label: "对话", icon: MessageCircle }, ...featurePages];

type PendingAgenda = {
  day: string;
  tab: "todo" | "repeat";
};

function NavigationTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="navigation-tooltip"
          side="right"
          align="center"
          sideOffset={10}
          collisionPadding={10}
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function App() {
  const { hiddenNavigation } = useGeneralPreferences();
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("bai-sidebar-width"));
    return Number.isFinite(saved) && saved >= 180 ? Math.min(saved, 420) : 224;
  });
  function resizeSidebar(value: number) {
    setSidebarWidth(value);
    localStorage.setItem("bai-sidebar-width", String(value));
  }
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [learningSidebar, setLearningSidebar] = useState({ available: false, expanded: false });
  const learningClosing = useRef(false);
  useEffect(() => {
    const update = (event: Event) => setLearningSidebar((event as CustomEvent).detail);
    window.addEventListener("xiaoxi-learning-outline-state", update);
    return () => window.removeEventListener("xiaoxi-learning-outline-state", update);
  }, []);
  useEffect(() => {
    if (!isTauri() || new URLSearchParams(location.search).get("view") === "reminder") return;
    const unlisten = listen<boolean>("xiaoxi-close-learning", async (event) => {
      if (learningClosing.current) return;
      learningClosing.current = true;
      try {
        await flushLearningDrafts();
        await api("/learning/sessions/end-all", "POST");
        window.dispatchEvent(new Event("xiaoxi-learning-ended"));
        await invoke("finish_learning_close", { quit: event.payload });
      } catch (cause) {
        setError(`结束学习未完成，窗口已保留：${(cause as Error).message}`);
        await getCurrentWindow().show(); await getCurrentWindow().setFocus();
      } finally { learningClosing.current = false; }
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);
  const [page, setPage] = useState<Page>("chat");
  const [learningHomeKey, setLearningHomeKey] = useState(0);
  const [openTodoId, setOpenTodoId] = useState<string>();
  const [knowledgeSource, setKnowledgeSource] = useState<KnowledgeSource>();
  useEffect(() => {
    const open = (event: Event) => { setKnowledgeSource((event as CustomEvent<KnowledgeSource>).detail); setPage("knowledge"); };
    window.addEventListener("xiaoxi-open-knowledge", open); return () => window.removeEventListener("xiaoxi-open-knowledge", open);
  }, []);
  const [calendarEventId, setCalendarEventId] = useState<string>();
  const [planAgenda, setPlanAgenda] = useState<PendingAgenda>();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [contextSettingsTarget, setContextSettingsTarget] = useState<ModelContextTarget>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectOverviewId, setProjectOverviewId] = useState<string | null>(
    null,
  );
  const [projectPanelRequest, setProjectPanelRequest] =
    useState<ProjectManagementRequest | null>(null);
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [learningOpenRequest, setLearningOpenRequest] = useState<{ goalId: string; sessionId?: string; key: number }>();
  useEffect(() => {
    const open = (event: Event) => {
      setProjectPanelRequest(null);
      setLearningOpenRequest((event as CustomEvent).detail);
      setPage("learning");
    };
    window.addEventListener("xiaoxi-open-learning", open);
    return () => window.removeEventListener("xiaoxi-open-learning", open);
  }, []);
  const [projectRevision, setProjectRevision] = useState(0);
  const [newChatPinned, setNewChatPinned] = useState(false);
  const selectedConversation = conversations.find(
    (item) => item.id === conversationId,
  );
  const resolvedProjectId = selectedConversation
    ? selectedConversation.project_id || null
    : activeProjectId;
  const overviewProject = projects.find(
    (item) => item.id === projectOverviewId,
  );
  function openProjectPanel(id: string, action: "library" | "settings") {
    setProjectPanelRequest((previous) => ({
      id,
      action,
      key: (previous?.key || 0) + 1,
    }));
  }
  function openProject(id: string, saved?: Project) {
    if (saved) setProjects((items) => items.some((item) => item.id === saved.id)
      ? items.map((item) => item.id === saved.id ? saved : item)
      : [...items, saved]);
    navigate("projects");
    setProjectOverviewId(id);
    setActiveProjectId(id);
  }
  function openConversation(
    conversation: Conversation,
    messageId?: string | null,
  ) {
    setProjectPanelRequest(null);
    setProjectOverviewId(null);
    setActiveProjectId(conversation.project_id || null);
    setConversations((items) =>
      items.map((item) => (item.id === conversation.id ? conversation : item)),
    );
    setConversationId(conversation.id);
    setFocusMessageId(messageId || null);
    navigate("chat");
  }
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [planOccurrence, setPlanOccurrence] = useState<string | null>();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [error, setError] = useState("");
  const [reminderBusy, setReminderBusy] = useState(false);
  const reminderAction = useRef(false);
  const [loading, setLoading] = useState(true);
  const [createKey, setCreateKey] = useState(0);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [info, setInfo] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const refreshVersion = useRef(0);
  const isReminderWindow =
    new URLSearchParams(location.search).get("view") === "reminder";
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const values = await Promise.all([
      api<Settings>("/settings"),
      api<Conversation[]>("/conversations"),
      api<Goal[]>("/learning/goals"),
      api<Memory[]>("/memories"),
      api<Notification[]>("/notifications?unread_only=true"),
      api<Project[]>("/projects"),
    ]);
    // Slow earlier snapshots must not overwrite a newer tool/memory update.
    if (version !== refreshVersion.current) return;
    setSettings((current) =>
      JSON.stringify(current) === JSON.stringify(values[0])
        ? current
        : values[0],
    );
    setConversations((current) =>
      JSON.stringify(current) === JSON.stringify(values[1])
        ? current
        : values[1],
    );
    setGoals((current) =>
      JSON.stringify(current) === JSON.stringify(values[2])
        ? current
        : values[2],
    );
    setMemories((current) =>
      JSON.stringify(current) === JSON.stringify(values[3])
        ? current
        : values[3],
    );
    setNotifications((current) =>
      JSON.stringify(current) === JSON.stringify(values[4])
        ? current
        : values[4],
    );
    setProjects((current) =>
      JSON.stringify(current) === JSON.stringify(values[5])
        ? current
        : values[5],
    );
  }, []);
  const boot = useCallback(async () => {
    setLoading(true);
    setError("");
    for (let i = 0; i < 30; i++) {
      try {
        await refresh();
        setLoading(false);
        return;
      } catch (error) {
        if (i === 29) {
          setError((error as Error).message);
          setLoading(false);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [refresh]);
  useEffect(() => {
    void boot();
  }, [boot]);
  useEffect(() => {
    if (!settings) return;
    let live = true;
    let timer = 0;
    async function poll() {
      try {
        const values = await api<Notification[]>(
          "/notifications?unread_only=true",
        );
        if (live)
          setNotifications((current) =>
            JSON.stringify(current) === JSON.stringify(values)
              ? current
              : values,
          );
      } catch {
        /* Native reminders remain available during connection interruptions. */
      }
      if (live) timer = window.setTimeout(() => void poll(), 5000);
    }
    timer = window.setTimeout(() => void poll(), 5000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [Boolean(settings)]);
  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen("bai-reminder", () => {
      void refresh();
    });
    return () => {
      void stop.then((fn) => fn());
    };
  }, [refresh]);
  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen<string>("bai-tray-action", (event) => {
      if (event.payload === "new_chat") startNewChat();
      else if (event.payload === "plans") {
        const day = new Intl.DateTimeFormat("en-CA", {
          timeZone: settings?.timezone || "Asia/Shanghai",
        }).format(new Date());
        setPlanAgenda({ day, tab: "todo" });
        navigate("plans");
      } else if (event.payload === "settings") navigate("settings");
      else if (event.payload === "skills") {
        setPage("settings");
        setSettingsTab("skills");
      }
    });
    return () => {
      void stop.then((fn) => fn());
    };
  }, [settings?.timezone]);
  function navigate(value: string, create = false) {
    if (value === "learning" && !create) setLearningHomeKey((key) => key + 1);
    setProjectPanelRequest(null);
    if (value === "reminders" || value === "calendar") value = "plans";
    // Top-level navigation must never inherit the selected project detail.
    // Project links use openProject explicitly; chat links keep their existing
    // conversation selection while returning to the actual conversation view.
    if (value === "chat" || value === "projects") setProjectOverviewId(null);
    if (
      value === "memories" ||
      value === "tools" ||
      value === "skills" ||
      value === "runtimes"
    ) {
      setPage("settings");
      setSettingsTab(value);
    } else {
      setPage(value as Page);
      if (value === "settings") setSettingsTab("general");
    }
    if (create) setCreateKey(Date.now());
    else setCreateKey(0);
  }
  async function deleteConversation() {
    if (!deleting) return;
    try {
      const result = await api<{ cleanup_pending: number }>(
        `/conversations/${deleting.id}`,
        "DELETE",
      );
      window.dispatchEvent(
        new CustomEvent("bai-conversation-deleted", { detail: deleting.id }),
      );
      try {
        localStorage.removeItem(`bai-chat-draft:${deleting.id}`);
        localStorage.removeItem(`bai-chat-model:${deleting.id}`);
      } catch {
        /* Storage restrictions must not prevent deletion. */
      }
      if (conversationId === deleting.id) setConversationId(null);
      await refresh();
      setDeleting(null);
      if (result.cleanup_pending)
        setError(
          "对话记录已删除，部分文件被占用，暂未从磁盘清理；请关闭占用文件后在数据目录中处理。",
        );
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const unread = notifications.filter((x) =>
    ["pending", "presented"].includes(x.status),
  ).length;
  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => !collapsed);
  }
  async function acknowledgeReminders() {
    if (reminderAction.current) return;
    reminderAction.current = true;
    setReminderBusy(true);
    setError("");
    try {
      const visible = notifications.filter((x) =>
        ["pending", "presented"].includes(x.status),
      );
      for (const value of visible.slice(0, 3))
        await api(`/notifications/${value.id}/ack?read=true`, "POST");
      await refresh();
      if (visible.length <= 3) await getCurrentWindow().close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      reminderAction.current = false;
      setReminderBusy(false);
    }
  }
  function startNewChat() {
    setSidebarCollapsed(true);
    setProjectOverviewId(null);
    setNewChatPinned(false);
    try {
      localStorage.removeItem("bai-chat-draft:new");
      localStorage.removeItem("bai-chat-model:new");
    } catch {
      /* A blocked storage API must not prevent starting a new chat. */
    }
    setConversationId(null);
    setChatKey((value) => value + 1);
    navigate("chat");
  }
  function openPlan(planId: string, occurrence?: string | null) {
    setPlanAgenda(undefined);
    setCalendarEventId(planId);
    setPlanOccurrence(occurrence);
    navigate("plans");
  }
  function openAgenda(plan: {
    start: string;
    occurrence_start?: string | null;
    recurrence?: string;
  }) {
    const start = plan.occurrence_start || plan.start;
    const day =
      start.length === 10
        ? start
        : new Intl.DateTimeFormat("en-CA", {
            timeZone: settings?.timezone || "Asia/Shanghai",
          }).format(new Date(start));
    setCalendarEventId(undefined);
    setPlanOccurrence(undefined);
    setPlanAgenda({
      day,
      tab: plan.recurrence && plan.recurrence !== "none" ? "repeat" : "todo",
    });
    navigate("plans");
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (document.querySelector('[role="dialog"]')) return;
      const key = event.key.toLowerCase();
      if (event.key === "F1") {
        event.preventDefault();
        setShortcuts(true);
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey)
        return;
      if (key === "n") {
        event.preventDefault();
        startNewChat();
      } else if (key === ",") {
        event.preventDefault();
        navigate("settings");
      } else if (["1", "2", "3"].includes(key)) {
        event.preventDefault();
        navigate(["chat", "learning", "plans"][Number(key) - 1]);
      }
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  if (loading)
    return (
      <WindowFrame collapsed={sidebarCollapsed} reminder={isReminderWindow}>
        <div className="boot-screen">
          <div className="brand-icon large">
            <BaiAvatar />
          </div>
          <h1>XiaoXi</h1>
          <p>
            <Loader2 size={16} className="spin" />
            正在打开你的个人空间…
          </p>
        </div>
      </WindowFrame>
    );
  if (!settings)
    return (
      <WindowFrame collapsed={sidebarCollapsed} reminder={isReminderWindow}>
        <div className="boot-screen">
          <h1>暂时无法连接本机服务</h1>
          <ErrorNotice message={error || "请检查后端服务是否正常启动。"} />
          <Button onClick={() => void boot()}>重新连接</Button>
        </div>
      </WindowFrame>
    );
  if (isReminderWindow)
    return (
      <div className="reminder-popup">
        <section
          className="reminder-card"
          role="dialog"
          aria-label="XiaoXi提醒你"
        >
          <header className="popup-heading" data-tauri-drag-region>
            <span className="popup-heading-icon">
              <Bell size={20} />
            </span>
            <span className="popup-heading-copy" data-tauri-drag-region>
              <small>到时间了</small>
              <strong>XiaoXi提醒你</strong>
            </span>
            <button
              className="popup-dismiss"
              aria-label="关闭提醒窗口，保留未读"
              disabled={reminderBusy}
              onClick={() =>
                void getCurrentWindow()
                  .close()
                  .catch((error: Error) => setError(error.message))
              }
            >
              <X size={16} />
            </button>
          </header>
          {error && (
            <ErrorNotice message={error} onClose={() => setError("")} />
          )}
          <div className="popup-list">
            {notifications
              .filter((x) => ["pending", "presented"].includes(x.status))
              .slice(0, 3)
              .map((value) => (
                <article className="popup-item" key={value.id}>
                  <div className="popup-item-copy">
                    <h2>{value.title}</h2>
                    <p>{value.body || "给这件事留一点时间。"}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={reminderBusy}
                    onClick={async () => {
                      if (reminderAction.current) return;
                      reminderAction.current = true;
                      setReminderBusy(true);
                      setError("");
                      try {
                        await api(`/notifications/${value.id}/snooze`, "POST", {
                          minutes: 10,
                        });
                        await refresh();
                        if (
                          notifications.filter((note) =>
                            ["pending", "presented"].includes(note.status),
                          ).length <= 1
                        )
                          await getCurrentWindow().close();
                      } catch (error) {
                        setError((error as Error).message);
                      } finally {
                        reminderAction.current = false;
                        setReminderBusy(false);
                      }
                    }}
                  >
                    10 分钟后再提醒
                  </Button>
                </article>
              ))}
          </div>
          <footer className="popup-actions">
            <span>
              {Math.min(
                notifications.filter((x) =>
                  ["pending", "presented"].includes(x.status),
                ).length,
                3,
              )}{" "}
              个提醒
            </span>
            <Button
              disabled={reminderBusy}
              onClick={() => void acknowledgeReminders()}
            >
              {reminderBusy ? "正在处理…" : "知道了"}
            </Button>
          </footer>
        </section>
      </div>
    );
  return (
    <WindowFrame
      collapsed={page === "learning" ? !learningSidebar.expanded : sidebarCollapsed}
      sidebarAvailable={page === "chat" || (page === "learning" && learningSidebar.available)}
      sidebarLabel={page === "learning" ? "课程目录" : "侧栏"}
      sidebarControls={page === "learning" ? "course-outline" : "chat-sidebar"}
      onToggle={page === "chat" ? toggleSidebar : page === "learning" ? () => window.dispatchEvent(new Event("xiaoxi-toggle-learning-outline")) : undefined}
      menuActions={{
        newChat: startNewChat,
        newLearning: () => navigate("learning", true),
        newPlan: () => navigate("plans", true),
        navigate,
        about: () => setInfo(true),
        shortcuts: () => setShortcuts(true),
      }}
      onReminders={() => setNotificationOpen(true)}
      unread={unread}
    >
      {error && <Toast tone="error" message={error} onClose={() => setError("")} />}
      <div
        className={`app-shell ${sidebarCollapsed || page !== "chat" ? "sidebar-collapsed" : ""}`}
        style={
          { "--chat-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties
        }
      >
        <aside
          id="bai-sidebar"
          className="sidebar"
          aria-label="应用导航与历史对话"
        >
          <div className="navigation-rail">
            <Tooltip.Provider
              delayDuration={220}
              skipDelayDuration={100}
              disableHoverableContent
            >
              <BaiAvatar
                interactive
                className="rail-avatar"
                label="点击头像新建对话"
                onClick={startNewChat}
              />
              <nav className="main-navigation" aria-label="主导航">
                {pages.filter((value) => value.id === "chat" || !hiddenNavigation.includes(value.id)).map((value) => (
                  <NavigationTooltip key={value.id} label={value.label}>
                    <button
                      className={page === value.id ? "active" : ""}
                      aria-current={page === value.id ? "page" : undefined}
                      aria-label={value.label}
                      onClick={() => navigate(value.id)}
                    >
                      <value.icon size={20} />
                    </button>
                  </NavigationTooltip>
                ))}
                <NavigationOverflowMenu items={featurePages} currentPage={page} onNavigate={navigate} />
              </nav>
              <div className="sidebar-footer">
                <NavigationTooltip label="连接与设置">
                  <button
                    className={page === "settings" ? "active" : ""}
                    aria-label="连接与设置"
                    aria-current={page === "settings" ? "page" : undefined}
                    onClick={() => navigate("settings")}
                  >
                    <Settings2 size={20} />
                    {(memories.some((x) => x.state === "candidate") ||
                      !settings.model_configured) && (
                      <span className="setup-dot" />
                    )}
                  </button>
                </NavigationTooltip>
                <NavigationTooltip label="关于">
                  <button
                    onClick={() => setInfo(true)}
                    aria-label="关于这个空间"
                  >
                    <CircleHelp size={19} />
                  </button>
                </NavigationTooltip>
              </div>
            </Tooltip.Provider>
          </div>
          <div
            className="chat-sidebar"
            id="chat-sidebar"
            hidden={sidebarCollapsed || page !== "chat"}
          >
            <ProjectSidebar
              visible={page === "chat" && !sidebarCollapsed}
              conversations={conversations}
              projects={projects}
              currentId={conversationId}
              projectId={resolvedProjectId}
              onNew={(id, pinned) => {
                setActiveProjectId(id);
                setFocusMessageId(null);
                startNewChat();
                setNewChatPinned(Boolean(pinned));
              }}
              onProject={openProject}
              onOpen={openConversation}
              onManage={setProjectPanelRequest}
              onDelete={setDeleting}
              refresh={refresh}
            />
          </div>
          {page === "chat" && !sidebarCollapsed && (
            <SidebarResize width={sidebarWidth} onChange={resizeSidebar} />
          )}
        </aside>
        <main className="main-panel">
          <div className="page-body" hidden={projectEditorOpen}>
            <Suspense
              fallback={
                <p className="page-content" role="status">
                  正在打开页面…
                </p>
              }
            >
              {page === "projects" && !overviewProject && <ProjectsPage projects={projects} conversations={conversations}
                onOpen={openProject}
                onCreate={() => setProjectPanelRequest({ id: null, action: "create", key: Date.now() })} />}
              {page === "projects" && overviewProject && (
                <ProjectOverview
                  key={overviewProject.id}
                  project={overviewProject}
                  conversations={conversations}
                  revision={projectRevision}
                  onBack={() => { setProjectOverviewId(null); navigate("projects"); }}
                  onNew={() => {
                    setActiveProjectId(overviewProject.id);
                    startNewChat();
                  }}
                  onOpen={openConversation}
                  onLibrary={() =>
                    openProjectPanel(overviewProject.id, "library")
                  }
                  onSettings={() =>
                    openProjectPanel(overviewProject.id, "settings")
                  }
                />
              )}
              {page === "chat" && (
                <ChatPage
                  key={chatKey}
                  conversationId={conversationId}
                  projectId={resolvedProjectId}
                  projects={projects}
                  pinNew={newChatPinned}
                  onProjectChange={(id, conversation) => {
                    setActiveProjectId(id);
                    if (conversation)
                      setConversations((items) =>
                        items.map((item) =>
                          item.id === conversation.id ? conversation : item,
                        ),
                      );
                  }}
                  onProjectOpen={openProject}
                  onLibrary={(id) => openProjectPanel(id, "library")}
                  focusMessageId={focusMessageId}
                  onMessageFocused={() => setFocusMessageId(null)}
                  onConversation={(id) => {
                    const known = conversations.find((item) => item.id === id);
                    if (known) openConversation(known);
                    else {
                      setProjectOverviewId(null);
                      setConversationId(id);
                    }
                  }}
                  settings={settings}
                  goals={goals}
                  conversations={conversations}
                  memories={memories}
                  refresh={refresh}
                  onAction={navigate}
                  onContextSettings={(providerId, modelName) => {
                    navigate("settings");
                    setSettingsTab("connections");
                    setContextSettingsTarget({ providerId, modelName });
                  }}
                  onPlan={openAgenda}
                />
              )}{" "}
              {page === "learning" && (
                <LearningPage
                  key={`learning-${createKey}-${learningHomeKey}`}
                  goals={goals}
                  refresh={refresh}
                  onSettings={() => { navigate("settings"); setSettingsTab("connections"); }}
                  createRequested={createKey}
                  openRequest={learningOpenRequest}
                  onOpenHandled={() => setLearningOpenRequest(undefined)}
                />
              )}{" "}
              {page === "plans" && (
                <Suspense
                  fallback={
                    <p className="page-content" role="status">
                      正在打开日历…
                    </p>
                  }
                >
                  <CalendarPage
                    key={`plans-${createKey}`}
                    createRequested={createKey}
                    openOccurrenceStart={planOccurrence}
                    openAgenda={planAgenda}
                    timezone={settings.timezone}
                    refresh={refresh}
                    openEventId={calendarEventId}
                    openTodoId={openTodoId}
                    onOpened={() => {
                      setOpenTodoId(undefined);
                      setCalendarEventId(undefined);
                      setPlanAgenda(undefined);
                    }}
                  />
                </Suspense>
              )}
              {page === "knowledge" && <KnowledgePage openSource={knowledgeSource} onOpened={() => setKnowledgeSource(undefined)} />}
              {page === "settings" && (
                <SettingsPage
                  settings={settings}
                  onSaved={setSettings}
                  memories={memories}
                  refresh={refresh}
                  tab={settingsTab}
                  contextTarget={contextSettingsTarget}
                  onContextTargetHandled={() => setContextSettingsTarget(undefined)}
                  onTab={setSettingsTab}
                  createRequested={createKey}
                />
              )}
            </Suspense>
          </div>
          <ProjectManagement projects={projects} conversations={conversations} currentId={conversationId}
            request={projectPanelRequest} refresh={refresh} onEditorOpenChange={setProjectEditorOpen}
            onProject={openProject}
            onDeleted={(id) => {
              setProjects((items) => items.filter((item) => item.id !== id));
              setConversations((items) => items.map((item) => item.project_id === id ? { ...item, project_id: null } : item));
              if (projectOverviewId === id) setProjectOverviewId(null);
              if (activeProjectId === id) setActiveProjectId(null);
            }}
            onLibraryChange={() => setProjectRevision((value) => value + 1)} />
        </main>
        <NotificationsPanel
          open={notificationOpen}
          onOpenChange={setNotificationOpen}
          notifications={notifications}
          refresh={refresh}
          onTodo={(id) => { setOpenTodoId(id); setPage("plans"); }}
          onPlan={(id, occurrence) => {
            openPlan(id, occurrence);
          }}
        />
        <ConfirmDelete
          open={Boolean(deleting)}
          title="删除这段对话？"
          description="将删除聊天消息、运行记录和专属附件、生成文件。已经保存的记忆、课程或提醒会保留。"
          label="删除对话"
          error={error}
          onClose={() => setDeleting(null)}
          onConfirm={deleteConversation}
        />
        <Dialog open={info} onOpenChange={setInfo}>
          <DialogContent className="about-dialog">
            <DialogHeader>
              <DialogTitle>你的个人空间</DialogTitle>
              <DialogDescription>
                XiaoXi · 0.1.8{import.meta.env.DEV ? " 开发版" : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="about-copy">
              <p>
                一个帮你查资料、逐步学习、记住重要信息和安排提醒的个人助手。
              </p>
              <p>
                当前数据保存在本机。关闭窗口后继续在托盘运行；退出应用或关闭电脑后，本机提醒暂停。
              </p>
              <p>
                模型与搜索接口由你配置。技能脚本需要单独授权，运行环境和依赖由你准备。
              </p>
              <p>手机互联与云端持续提醒将在后续版本加入。</p>
            </div>
            <DialogFooter>
              <Button onClick={() => setInfo(false)}>知道了</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog open={shortcuts} onOpenChange={setShortcuts}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>快捷键</DialogTitle>
              <DialogDescription>XiaoXi</DialogDescription>
            </DialogHeader>
            <dl className="shortcut-list">
              {[
                ["新建对话", "Ctrl+N"],
                ["对话 / 学习 / 计划", "Ctrl+1 / 2 / 3"],
                ["连接与设置", "Ctrl+,"],
                ["打开快捷键", "F1"],
                ["发送消息", "Enter"],
                ["输入框换行", "Shift+Enter"],
              ].map(([label, keys]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <kbd>{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
            <DialogFooter>
              <Button onClick={() => setShortcuts(false)}>知道了</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </WindowFrame>
  );
}
