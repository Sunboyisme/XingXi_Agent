import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarPlus,
  ChevronRight,
  Lightbulb,
  ListChecks,
  MessageCircle,
  MessagesSquare,
  NotebookPen,
} from "lucide-react";
import {
  api,
  type CalendarEvent,
  type Conversation,
  type Goal,
} from "@/lib/api";
import { Hint } from "./common";

export function ChatHome({
  conversations,
  goals,
  timezone,
  onConversation,
  onAction,
  onPlan,
  onPrompt,
}: {
  conversations: Conversation[];
  goals: Goal[];
  timezone: string;
  onConversation: (id: string) => void;
  onAction: (page: string, create?: boolean) => void;
  onPlan: (plan: CalendarEvent) => void;
  onPrompt: (text: string) => void;
}) {
  const [plans, setPlans] = useState<CalendarEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(
    new Date(),
  );
  useEffect(() => {
    // Civil date arithmetic keeps the exclusive range correct across DST changes.
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    let live = true;
    api<CalendarEvent[]>(
      `/plans?start=${today}&end=${tomorrow.toISOString().slice(0, 10)}`,
    )
      .then((value) => {
        if (live) setPlans(value.filter((plan) => plan.status === "planned"));
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [today]);

  const recent = [...conversations].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  )[0];
  const goal = [...goals]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .find((value) => value.status !== "completed");
  const node =
    goal?.nodes.find((value) => value.id === goal.current_node_id) ||
    goal?.nodes[0];

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

  const promptIdeas = [
    {
      label: "安排今天",
      accessibleLabel: "添加安排",
      icon: CalendarPlus,
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
      icon: Lightbulb,
      prompt: "请用一个生活里的例子，把这个概念讲清楚：\n\n",
    },
    {
      label: "提炼重点",
      accessibleLabel: "提炼重点",
      icon: ListChecks,
      prompt: "请把下面的内容提炼成三条重点，并告诉我最值得先做的一件事：\n\n",
    },
    {
      label: "随便聊聊",
      accessibleLabel: "随便聊聊",
      icon: MessagesSquare,
      prompt: "我今天有点想聊聊。先问问我最近在忙什么吧。",
    },
  ];

  return (
    <section className="chat-home" aria-label="首页内容">
      <div className="home-shortcuts" aria-label="快捷提示">
        {promptIdeas.map(({ label, accessibleLabel, icon: Icon, prompt }) => (
          <Hint key={label} label={prompt}>
            <button
              aria-label={accessibleLabel || label}
              onClick={() => onPrompt(prompt)}
            >
              <Icon size={15} />
              {label}
            </button>
          </Hint>
        ))}
        <button onClick={continueLearning}>
          <BookOpen size={15} />
          继续学习
        </button>
      </div>
      <div className="home-today-columns">
        <section>
          <div className="home-section-heading">
            <h2>今日安排</h2>
            <button onClick={() => onAction("plans")}>
              全部计划
              <ChevronRight size={14} />
            </button>
          </div>
          {plans?.length ? (
            <div className="home-agenda">
              {plans.slice(0, 3).map((plan) => (
                <button
                  key={`${plan.id}:${plan.start}`}
                  onClick={() => onPlan(plan)}
                  aria-label={`打开计划 ${plan.title}`}
                >
                  <span className="home-agenda-dot" />
                  <time>
                    {plan.all_day
                      ? "全天"
                      : new Intl.DateTimeFormat("zh-CN", {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                          timeZone: timezone,
                        }).format(new Date(plan.start))}
                  </time>
                  <strong>{plan.title}</strong>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
          ) : (
            <div className="home-open-day">
              <CalendarPlus size={23} strokeWidth={1.3} />
              <div>
                <strong>
                  {failed
                    ? "暂时没有读到计划"
                    : plans
                      ? "今天的时间，留给想做的事"
                      : "正在查看今天的安排…"}
                </strong>
                <p>
                  {failed
                    ? "可以打开全部计划再试一次。"
                    : "先安排一件小事，也给自己留一点空闲。"}
                </p>
              </div>
              <button
                aria-label="添加今天的计划"
                onClick={() => onAction("plans", true)}
              >
                <ArrowRight size={18} />
              </button>
            </div>
          )}
        </section>
        <section>
          <div className="home-section-heading">
            <h2>上次任务</h2>
          </div>
          <div className="home-continue-list">
            <button onClick={continueLearning}>
              <BookOpen size={18} />
              <span>
                <strong>{goal?.title || "给自己一个小小的学习目标"}</strong>
                <small>{node?.title || "从感兴趣的内容开始，慢慢学会"}</small>
              </span>
              <ArrowUpRight size={15} />
            </button>
            <button
              onClick={() =>
                recent
                  ? onConversation(recent.id)
                  : onPrompt("我想和你聊聊最近的想法：")
              }
            >
              <MessageCircle size={18} />
              <span>
                <strong>{recent?.title || "聊聊最近的想法"}</strong>
                <small>
                  {recent ? "回到最近的一次对话" : "从一句话开始就好"}
                </small>
              </span>
              <ArrowUpRight size={15} />
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}
