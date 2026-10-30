import { useEffect, useState } from "react";
import {
  BookOpen,
  FileText,
  ListTree,
  PenLine,
  WandSparkles,
} from "lucide-react";
import { BaiAvatar } from "./BaiAvatar";

const starters = [
  {
    label: "总结内容",
    icon: FileText,
    prompt:
      "请帮我总结以下内容，提炼核心结论、关键要点和需要关注的问题，不补充原文没有的信息。内容：",
  },
  {
    label: "润色改写",
    icon: PenLine,
    prompt:
      "请帮我润色以下文字，在保留原意和事实的基础上，让表达更清楚、自然、简洁。文字：",
  },
  {
    label: "优化提示词",
    icon: WandSparkles,
    prompt:
      "请帮我优化下面的提示词。先理解我要达成的目标，检查任务、背景、约束和输出格式是否清楚；缺少关键信息时先问我最多三个问题。给出可直接复制使用的完整提示词，并简要说明主要改动，不擅自补充事实。原提示词：",
  },
  {
    label: "拆解任务",
    icon: ListTree,
    prompt:
      "请根据我上传的文件或下面的工作描述，帮我把任务拆成可执行的步骤。先梳理目标、交付物和限制，再给出任务清单、先后顺序、依赖关系、预计投入和第一步建议；信息不足时先问关键问题。先给出安排建议。工作内容：",
  },
];

export function NewChatStarters({
  onPrompt,
  onLearning,
  disabled,
}: {
  onPrompt: (prompt: string) => void;
  onLearning: () => void;
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
      <button type="button" disabled={disabled} onClick={onLearning}>
        <BookOpen size={15} strokeWidth={1.5} aria-hidden="true" />
        <span>继续学习</span>
      </button>
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
