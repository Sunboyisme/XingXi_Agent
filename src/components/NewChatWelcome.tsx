import { useEffect, useState } from "react";

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
      <time
        className="new-chat-date"
        dateTime={date}
        aria-label={format.format(now)}
      >
        <span className="new-chat-day" aria-hidden="true">
          {day}
        </span>
        <span className="new-chat-date-details" aria-hidden="true">
          <span>{year}年{month}月</span>
          <strong>{part("weekday")}</strong>
        </span>
      </time>
      <h1>今天想做些什么？</h1>
    </section>
  );
}
