import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  ChevronRight,
  Folder,
  GraduationCap,
  MessageCircle,
  NotebookPen,
  Sparkles,
} from "lucide-react";
import {
  api,
  type CalendarEvent,
  type Conversation,
  type Goal,
  type Project,
} from "@/lib/api";
import { Hint } from "./common";

const promptIdeas = [
  {
    label: "安排今天",
    accessibleLabel: "添加安排",
    icon: CalendarDays,
    prompt:
      "帮我安排今天的时间。先问问我今天最想完成什么，再给出一个轻松可行的安排。",
  },
  {
    label: "整理文字",
    accessibleLabel: "整理笔记",
    icon: NotebookPen,
    prompt: "请把下面这段文字整理成清晰的笔记：\n\n",
  },
  {
    label: "解释概念",
    accessibleLabel: "解释概念",
    icon: GraduationCap,
    prompt: "请用一个生活里的例子，把这个概念讲清楚：\n\n",
  },
  {
    label: "提炼重点",
    accessibleLabel: "提炼重点",
    icon: Sparkles,
    prompt: "请把下面的内容提炼成三条重点，并告诉我最值得先做的一件事：\n\n",
  },
  {
    label: "随便聊聊",
    accessibleLabel: "随便聊聊",
    icon: MessageCircle,
    prompt: "我今天有点想聊聊。先问问我最近在忙什么吧。",
  },
];

type DailyPlans = {
  day: string;
  timezone: string;
  items: CalendarEvent[];
  failed: boolean;
};

export function ChatHome({
  conversations,
  goals,
  projects = [],
  timezone,
  onConversation,
  onAction,
  onPlan,
  onPrompt,
  onProjectOpen,
}: {
  conversations: Conversation[];
  goals: Goal[];
  projects?: Project[];
  timezone: string;
  onConversation: (id: string) => void;
  onAction: (page: string, create?: boolean) => void;
  onPlan: (plan: CalendarEvent) => void;
  onPrompt: (text: string) => void;
  onProjectOpen?: (id: string) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const [plans, setPlans] = useState<DailyPlans | null>(null);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(
    now,
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    // Civil date arithmetic keeps the exclusive range correct across DST changes.
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    let live = true;
    api<CalendarEvent[]>(
      `/plans?start=${today}&end=${tomorrow.toISOString().slice(0, 10)}&timezone=${encodeURIComponent(timezone)}`,
    )
      .then((value) => {
        if (!live) return;
        setPlans({
          day: today,
          timezone,
          items: value
            .filter((plan) => plan.status === "planned")
            .sort(
              (a, b) =>
                Number(b.all_day) - Number(a.all_day) ||
                a.start.localeCompare(b.start),
            ),
          failed: false,
        });
      })
      .catch(() => {
        if (live) setPlans({ day: today, timezone, items: [], failed: true });
      });
    return () => {
      live = false;
    };
  }, [today, timezone]);

  const daily =
    plans?.day === today && plans.timezone === timezone ? plans : null;
  const firstPlan = daily?.items[0];
  const recent = conversations.reduce<Conversation | undefined>(
    (latest, value) =>
      !latest || value.updated_at > latest.updated_at ? value : latest,
    undefined,
  );
  const goal = goals.reduce<Goal | undefined>(
    (latest, value) =>
      value.status !== "completed" &&
      (!latest || value.updated_at > latest.updated_at)
        ? value
        : latest,
    undefined,
  );
  const node =
    goal?.nodes.find((value) => value.id === goal.current_node_id) ||
    goal?.nodes[0];
  const recentProject = useMemo(() => {
    // Project metadata alone does not change when a conversation is continued.
    const activity = new Map<string, string>();
    for (const conversation of conversations) {
      if (
        conversation.project_id &&
        conversation.updated_at > (activity.get(conversation.project_id) || "")
      )
        activity.set(conversation.project_id, conversation.updated_at);
    }
    function updatedAt(project: Project) {
      const chatTime = activity.get(project.id) || "";
      return chatTime > project.updated_at ? chatTime : project.updated_at;
    }
    return projects.reduce<Project | undefined>(
      (latest, value) =>
        !latest || updatedAt(value) > updatedAt(latest) ? value : latest,
      undefined,
    );
  }, [projects, conversations]);
  const project = onProjectOpen ? recentProject : undefined;

  function continueLearning() {
    if (goal) {
      try {
        localStorage.setItem("bai-current-goal", goal.id);
      } catch {
        /* Learning remains accessible without stored selection. */
      }
    }
    onAction("learning");
  }

  const planTime = firstPlan
    ? firstPlan.all_day
      ? "全天"
      : new Intl.DateTimeFormat("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: timezone,
        }).format(new Date(firstPlan.start))
    : "";
  const planDetail = firstPlan
    ? `${planTime}  ${firstPlan.title}`
    : !daily
      ? "正在查看今天的安排…"
      : daily.failed
        ? "暂时没有读到计划"
        : "安排一件想做的小事";

  return (
    <section className="chat-home" aria-label="首页内容">
      <div className="home-shortcuts" aria-label="快捷提示">
        {promptIdeas.map(({ label, accessibleLabel, icon: Icon, prompt }) => (
          <Hint key={label} label={prompt}>
            <button
              type="button"
              aria-label={accessibleLabel}
              onClick={() => onPrompt(prompt)}
            >
              <Icon size={27} strokeWidth={1.45} aria-hidden="true" />
              <span>{label}</span>
            </button>
          </Hint>
        ))}
      </div>
      <div className="home-resume-shelf" aria-label="继续今天的安排与任务">
        <button
          type="button"
          className="home-resume-item"
          aria-label={
            firstPlan
              ? `打开计划 ${firstPlan.title}`
              : daily?.failed || !daily
                ? "全部计划"
                : "添加今天的计划"
          }
          aria-busy={!daily}
          title={planDetail}
          onClick={() =>
            firstPlan
              ? onPlan(firstPlan)
              : daily && !daily.failed
                ? onAction("plans", true)
                : onAction("plans")
          }
        >
          <CalendarDays size={26} strokeWidth={1.45} aria-hidden="true" />
          <span className="home-resume-copy">
            <strong>今天</strong>
            <span>
              {firstPlan ? (
                <>
                  <time>{planTime}</time>{"  "}
                  <span>{firstPlan.title}</span>
                </>
              ) : (
                planDetail
              )}
            </span>
          </span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="home-resume-item"
          onClick={continueLearning}
          title={
            goal ? `${goal.title}${node ? ` · ${node.title}` : ""}` : undefined
          }
        >
          <BookOpen size={26} strokeWidth={1.45} aria-hidden="true" />
          <span className="home-resume-copy">
            <strong>{goal ? "继续学习" : "开始学习"}</strong>
            <span>{goal?.title || "给自己一个小小的学习目标"}</span>
          </span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="home-resume-item"
          title={project?.name || recent?.title}
          onClick={() => {
            if (project) onProjectOpen?.(project.id);
            else if (recent) onConversation(recent.id);
            else onPrompt("我想和你聊聊最近的想法：");
          }}
        >
          {project ? (
            <Folder size={26} strokeWidth={1.45} aria-hidden="true" />
          ) : (
            <MessageCircle size={26} strokeWidth={1.45} aria-hidden="true" />
          )}
          <span className="home-resume-copy">
            <strong>
              {project ? "最近项目" : recent ? "最近对话" : "聊聊想法"}
            </strong>
            <span>{project?.name || recent?.title || "从一句话开始就好"}</span>
          </span>
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
