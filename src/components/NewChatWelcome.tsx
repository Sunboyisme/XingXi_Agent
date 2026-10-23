import { useEffect, useState } from "react";
import { BookOpen, CalendarCheck, Lightbulb, PenLine } from "lucide-react";
import { BaiAvatar } from "./BaiAvatar";

const starters = [
  {
    label: "理清思路",
    icon: Lightbulb,
    prompt: "我有一些零散的想法，请帮我一起梳理：",
  },
  {
    label: "写点东西",
    icon: PenLine,
    prompt: "我想写点东西，先跟我聊聊选题和方向",
  },
  {
    label: "安排今天",
    icon: CalendarCheck,
    prompt: "请帮我规划一下今天的日程",
  },
  {
    label: "继续学习",
    icon: BookOpen,
    prompt: "我想继续学习，请帮我梳理接下来的学习内容。",
  },
];

export function NewChatStarters({
  onPrompt,
  disabled,
}: {
  onPrompt: (prompt: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="new-chat-starters" role="group" aria-label="开场建议">
      {starters.map(({ label, icon: Icon, prompt }) => (
        <button
          key={label}
          type="button"
          disabled={disabled}
          onClick={() => onPrompt(prompt)}
        >
          <Icon size={15} strokeWidth={1.5} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

export function NewChatWelcome({ timezone }: { timezone: string }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const update = () => setNow(new Date());
    const onVisibility = () => {
      if (!document.hidden) update();
    };
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const format = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
    timeZone: timezone,
  });
  const parts = format.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value || "";
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

  return (
    <section className="new-chat-welcome" aria-label="新对话欢迎">
      <BaiAvatar className="new-chat-avatar" motion="still" />
      <time
        className="new-chat-date"
        dateTime={date}
        aria-label={format.format(now)}
      >
        <span aria-hidden="true">
          {month}月{day}日，{part("weekday")}
        </span>
      </time>
      <h1>今天，想从哪里开始？</h1>
    </section>
  );
}
