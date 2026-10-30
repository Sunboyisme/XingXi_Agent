import { flushLearningDrafts } from "@/lib/learningLifecycle";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Bell, Loader2, X } from "lucide-react";
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
import { ChatPage, clearChatPreferences } from "./components/ChatPage";
const LearningPage = lazy(() =>
  import("./components/LearningPage").then((module) => ({
    default: module.LearningPage,
  })),
);
import { NotificationsPanel } from "./components/NotificationsPanel";
import type { SettingsTab } from "./components/SettingsPage";
import type { ModelContextTarget } from "./components/ModelConnections";
import { emptyRuntimeEditor } from "./lib/runtimeEditor";
const SettingsPage = lazy(() =>
  import("./components/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
import { ErrorNotice, Toast } from "./components/common";
import { BaiAvatar } from "./components/BaiAvatar";
import {
  ChatIcon,
  HelpIcon,
  KnowledgeIcon,
  LearningIcon,
  PlanIcon,
  ProjectIcon,
  SettingsIcon,
} from "./components/SoftIcons";
import { WindowFrame } from "./components/WindowFrame";
import { SidebarResize } from "./components/SidebarResize";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ProjectOverview } from "./components/ProjectOverview";
import { ProjectsPage } from "./components/ProjectsPage";
import { NavigationOverflowMenu, NavigationTooltip, type NavigationFeatureItem } from "./components/NavigationOverflowMenu";
import { ProjectManagement, type ProjectManagementRequest } from "./components/ProjectManagement";

type Page = "chat" | "projects" | "learning" | "plans" | "knowledge" | "settings";
const KnowledgePage = lazy(() => import("./components/KnowledgePage").then((module) => ({ default: module.KnowledgePage })));
import type { KnowledgeSource } from "./components/KnowledgeSources";
import { errorMessage, isActiveNotification, keepIfSame } from "./lib/utils";
import { zonedToday } from "./lib/calendarMonth";

const featurePages: NavigationFeatureItem[] = [
  {
    id: "projects",
    label: "项目",
    icon: ProjectIcon,
  },
  {
    id: "learning",
    label: "学习",
    icon: LearningIcon,
  },
  {
    id: "plans",
    label: "计划",
    icon: PlanIcon,
  },
  { id: "knowledge", label: "知识库", icon: KnowledgeIcon },
];
const pages = [{ id: "chat" as const, label: "对话", icon: ChatIcon }, ...featurePages];

type PendingAgenda = {
  day: string;
  tab: "todo" | "repeat";
};


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
        setError(`结束学习未完成，窗口已保留：${errorMessage(cause)}`);
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
  const [speechConfigureRequested, setSpeechConfigureRequested] = useState(false);
  const [contextSettingsTarget, setContextSettingsTarget] = useState<ModelContextTarget>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [runtimeEditor, setRuntimeEditor] = useState(emptyRuntimeEditor);
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
  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen<{ conversationId?: string; settings?: boolean; settingsTab?: string; newChat?: boolean }>("desktop-navigate", event => {
      if (event.payload.settings) {
        navigate("settings");
        setSettingsTab(event.payload.settingsTab === "services" ? "services" : "desktop");
        setSpeechConfigureRequested(event.payload.settingsTab === "services");
      }
      else if (event.payload.conversationId) {
        void api<Conversation[]>("/conversations").then(values => { const value = values.find(c => c.id === event.payload.conversationId); if (value) openConversation(value); else setError("这段对话已不存在"); void refresh(); }).catch(error => setError(errorMessage(error)));
      } else if (event.payload.newChat) startNewChat();
      else navigate("chat");
    });
    return () => { void stop.then(f => f()); };
  }, []);
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
  const [info, setInfo] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const refreshVersion = useRef(0);
  const bootController = useRef<AbortController | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const conversationDeletions = useRef(new Set<string>());
  const isReminderWindow =
    new URLSearchParams(location.search).get("view") === "reminder";
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    setRefreshing(true);
    const options = { timeoutMs: 10_000 };
    const values = await Promise.allSettled([
      api<Settings>("/settings", "GET", undefined, options),
      api<Conversation[]>("/conversations", "GET", undefined, options),
      api<Goal[]>("/learning/goals", "GET", undefined, options),
      api<Memory[]>("/memories", "GET", undefined, options),
      api<Notification[]>("/notifications?unread_only=true", "GET", undefined, options),
      api<Project[]>("/projects", "GET", undefined, options),
    ]);
    // Slow earlier snapshots must not overwrite a newer tool/memory update.
    if (version !== refreshVersion.current) return;
    if (values[0].status === "fulfilled") setSettings(keepIfSame(values[0].value));
    if (values[1].status === "fulfilled") setConversations(keepIfSame(values[1].value));
    if (values[2].status === "fulfilled") setGoals(keepIfSame(values[2].value));
    if (values[3].status === "fulfilled") setMemories(keepIfSame(values[3].value));
    if (values[4].status === "fulfilled") setNotifications(keepIfSame(values[4].value));
    if (values[5].status === "fulfilled") setProjects(keepIfSame(values[5].value));
    const labels = ["连接配置", "对话", "学习", "记忆", "通知", "项目"];
    const failures = values.flatMap((result, index) =>
      result.status === "rejected" ? [`${labels[index]}：${errorMessage(result.reason)}`] : [],
    );
    const message = failures.length ? `部分内容暂未刷新，已保留可用内容。${failures.join("；")}` : "";
    setRefreshError(message);
    setRefreshing(false);
    if (message) throw new Error(message);
  }, []);
  const boot = useCallback(async () => {
    bootController.current?.abort();
    const controller = new AbortController();
    bootController.current = controller;
    setLoading(true);
    setError("");
    const deadline = Date.now() + 15_000;
    while (!controller.signal.aborted) {
      try {
        const value = await api<Settings>("/settings", "GET", undefined, {
          signal: controller.signal,
          timeoutMs: Math.min(3_000, Math.max(1, deadline - Date.now())),
        });
        if (isReminderWindow) {
          const notes = await api<Notification[]>("/notifications?unread_only=true", "GET", undefined, {
            signal: controller.signal,
            timeoutMs: Math.min(3_000, Math.max(1, deadline - Date.now())),
          });
          if (!controller.signal.aborted) setNotifications(notes);
        }
        if (controller.signal.aborted) return;
        setSettings(value);
        setLoading(false);
        void refresh().catch(() => { /* Per-module errors are shown above the page. */ });
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (Date.now() >= deadline) {
          setError(errorMessage(error));
          setLoading(false);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }, [refresh, isReminderWindow]);
  useEffect(() => {
    void boot();
    return () => {
      bootController.current?.abort();
      refreshVersion.current++;
    };
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
        if (live) setNotifications(keepIfSame(values));
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
        setPlanAgenda({ day: zonedToday(settings?.timezone), tab: "todo" });
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
      value === "runtimes" ||
      value === "connections" ||
      value === "speech"
    ) {
      setPage("settings");
      setSettingsTab(value === "speech" ? "services" : value as SettingsTab);
      if (value === "speech") setSpeechConfigureRequested(true);
    } else {
      setPage(value as Page);
      if (value === "settings") setSettingsTab("general");
    }
    if (create) setCreateKey(Date.now());
    else setCreateKey(0);
  }
  async function deleteConversation(deleting: Conversation) {
    if (conversationDeletions.current.has(deleting.id)) throw new Error("这段对话正在删除，请稍候。");
    conversationDeletions.current.add(deleting.id);
    try {
      const result = await api<{ cleanup_pending: number }>(
        `/conversations/${deleting.id}`,
        "DELETE",
      );
      window.dispatchEvent(
        new CustomEvent("bai-conversation-deleted", { detail: deleting.id }),
      );
      clearChatPreferences(deleting.id);
      setConversationId((current) => current === deleting.id ? null : current);
      setConversations((items) => items.filter((item) => item.id !== deleting.id));
      await refresh().catch(() => setError("对话已删除，列表暂未刷新，请稍后刷新。"));
      if (result.cleanup_pending)
        setError(
          "对话记录已删除，部分文件被占用，暂未从磁盘清理；请关闭占用文件后在数据目录中处理。",
        );
    } finally {
      conversationDeletions.current.delete(deleting.id);
    }
  }
  const activeNotifications = notifications.filter(isActiveNotification);
  const unread = activeNotifications.length;
  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => !collapsed);
  }
  async function acknowledgeReminders() {
    if (reminderAction.current) return;
    reminderAction.current = true;
    setReminderBusy(true);
    setError("");
    try {
      const visible = activeNotifications;
      for (const value of visible.slice(0, 3))
        await api(`/notifications/${value.id}/ack?read=true`, "POST");
      await refresh();
      if (visible.length <= 3) await getCurrentWindow().close();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      reminderAction.current = false;
      setReminderBusy(false);
    }
  }
  function startNewChat() {
    setSidebarCollapsed(true);
    setProjectOverviewId(null);
    setNewChatPinned(false);
    clearChatPreferences(null);
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
          <Button variant="outline" onClick={() => {
            bootController.current?.abort();
            setError("已取消连接，可以重新连接本机服务。");
            setLoading(false);
          }}>取消连接</Button>
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
                  .catch((error) => setError(errorMessage(error)))
              }
            >
              <X size={16} />
            </button>
          </header>
          {error && (
            <ErrorNotice message={error} onClose={() => setError("")} />
          )}
          <div className="popup-list">
            {activeNotifications
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
                        if (activeNotifications.length <= 1)
                          await getCurrentWindow().close();
                      } catch (error) {
                        setError(errorMessage(error));
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
              {Math.min(activeNotifications.length, 3)}{" "}
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
                    <SettingsIcon size={20} />
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
                    <HelpIcon size={20} />
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
              onDelete={deleteConversation}
              refresh={refresh}
            />
          </div>
          {page === "chat" && !sidebarCollapsed && (
            <SidebarResize width={sidebarWidth} onChange={resizeSidebar} />
          )}
        </aside>
        <main className="main-panel">
          {refreshError && <ErrorNotice
            tone="warning"
            message={refreshing ? `正在重新读取… ${refreshError}` : refreshError}
            retry={refreshing ? undefined : () => void refresh().catch(() => {})}
          />}
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
                  memories={memories}
                  refresh={refresh}
                  onAction={navigate}
                  onContextSettings={(providerId, modelName) => {
                    navigate("settings");
                    setSettingsTab("connections");
                    setContextSettingsTarget({ providerId, modelName });
                  }}
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
                  runtimeEditor={runtimeEditor}
                  onRuntimeEditorChange={setRuntimeEditor}
                  memories={memories}
                  refresh={refresh}
                  tab={settingsTab}
                  contextTarget={contextSettingsTarget}
                  onContextTargetHandled={() => setContextSettingsTarget(undefined)}
                  speechConfigureRequested={speechConfigureRequested}
                  onSpeechConfigureHandled={() => setSpeechConfigureRequested(false)}
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
        <Dialog open={info} onOpenChange={setInfo}>
          <DialogContent className="about-dialog">
            <DialogHeader>
              <DialogTitle>你的个人空间</DialogTitle>
              <DialogDescription>
                XiaoXi · 0.1.9{import.meta.env.DEV ? " 开发版" : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="about-copy">
              <p>
                运行在你电脑上的个人助手：对话查资料、按项目整理工作、循序学习，管理计划与待办，并把资料沉淀进知识库和记忆。
              </p>
              <p>
                数据只保存在本机，密钥存放在系统凭据库。关闭窗口后留在托盘继续提醒；退出应用或关机后，提醒暂停。
              </p>
              <p>
                模型、搜索与图片生成接口由你配置；绑定微信后可在微信接收提醒。技能脚本需单独授权，运行环境由你准备。
              </p>
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
