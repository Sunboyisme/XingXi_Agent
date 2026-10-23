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
  Calendar,
  BookOpen,
  type LucideIcon,
  CircleHelp,
  Loader2,
  MessageCircle,
  Settings2,
  X,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
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
const SettingsPage = lazy(() =>
  import("./components/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
import { ConfirmDelete, ErrorNotice } from "./components/common";
import { BaiAvatar } from "./components/BaiAvatar";
import { WindowFrame } from "./components/WindowFrame";
import { SidebarResize } from "./components/SidebarResize";
import {
  ProjectSidebar,
  type ProjectPanelRequest,
} from "./components/ProjectSidebar";
import { ProjectOverview } from "./components/ProjectOverview";

type Page = "chat" | "learning" | "plans" | "settings";
const pages: {
  id: Page;
  label: string;
  icon: LucideIcon;
}[] = [
  {
    id: "chat",
    label: "对话",
    icon: MessageCircle,
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
];

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
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("bai-sidebar-width"));
    return Number.isFinite(saved) && saved >= 180 ? Math.min(saved, 420) : 224;
  });
  function resizeSidebar(value: number) {
    setSidebarWidth(value);
    localStorage.setItem("bai-sidebar-width", String(value));
  }
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("bai-sidebar-collapsed") === "true",
  );
  const [page, setPage] = useState<Page>("chat");
  const [calendarEventId, setCalendarEventId] = useState<string>();
  const [planAgenda, setPlanAgenda] = useState<PendingAgenda>();
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("connections");
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
    useState<ProjectPanelRequest | null>(null);
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
  function openConversation(
    conversation: Conversation,
    messageId?: string | null,
  ) {
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
    if (value === "reminders" || value === "calendar") value = "plans";
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
      if (value === "settings") setSettingsTab("connections");
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
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    localStorage.setItem("bai-sidebar-collapsed", String(collapsed));
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
      collapsed={sidebarCollapsed}
      sidebarAvailable={page === "chat"}
      onToggle={page === "chat" ? toggleSidebar : undefined}
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
                {pages.map((value) => (
                  <NavigationTooltip key={value.id} label={value.label}>
                    <button
                      className={page === value.id ? "active" : ""}
                      aria-current={page === value.id ? "page" : undefined}
                      aria-label={value.label}
                      onClick={() => navigate(value.id)}
                    >
                      <value.icon size={24} />
                      <span className="rail-label">{value.label}</span>
                    </button>
                  </NavigationTooltip>
                ))}
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
                    <span className="rail-label">设置</span>
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
              currentId={overviewProject ? null : conversationId}
              projectId={overviewProject?.id || resolvedProjectId}
              onNew={(id, pinned) => {
                setActiveProjectId(id);
                setFocusMessageId(null);
                startNewChat();
                setNewChatPinned(Boolean(pinned));
              }}
              onProject={(id) => {
                setActiveProjectId(id);
                setProjectOverviewId(id);
                navigate("chat");
              }}
              onOpen={openConversation}
              request={projectPanelRequest}
              onLibraryChange={() => setProjectRevision((value) => value + 1)}
              onDelete={setDeleting}
              refresh={refresh}
            />
          </div>
          {page === "chat" && !sidebarCollapsed && (
            <SidebarResize width={sidebarWidth} onChange={resizeSidebar} />
          )}
        </aside>
        <main className="main-panel">
          <div className="page-body">
            <Suspense
              fallback={
                <p className="page-content" role="status">
                  正在打开页面…
                </p>
              }
            >
              {page === "chat" && overviewProject && (
                <ProjectOverview
                  key={overviewProject.id}
                  project={overviewProject}
                  conversations={conversations}
                  revision={projectRevision}
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
              {page === "chat" && !overviewProject && (
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
                  onProjectOpen={(id) => setProjectOverviewId(id)}
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
                  onPlan={openAgenda}
                />
              )}{" "}
              {page === "learning" && (
                <LearningPage
                  key={`learning-${createKey}`}
                  goals={goals}
                  refresh={refresh}
                  onSettings={() => navigate("settings")}
                  createRequested={createKey}
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
                    onOpened={() => {
                      setCalendarEventId(undefined);
                      setPlanAgenda(undefined);
                    }}
                  />
                </Suspense>
              )}
              {page === "settings" && (
                <SettingsPage
                  settings={settings}
                  onSaved={setSettings}
                  memories={memories}
                  refresh={refresh}
                  tab={settingsTab}
                  onTab={setSettingsTab}
                  createRequested={createKey}
                />
              )}
            </Suspense>
          </div>
        </main>
        <NotificationsPanel
          open={notificationOpen}
          onOpenChange={setNotificationOpen}
          notifications={notifications}
          refresh={refresh}
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
                XiaoXi · 0.1.7{import.meta.env.DEV ? " 开发版" : ""}
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
