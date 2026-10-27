import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
} from "lucide-react";
import { Button } from "./ui/button";
import { dateMove, zonedToday } from "@/lib/calendarMonth";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const pad = (value: number) => String(value).padStart(2, "0");
function dateKey(date: Date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function dateLabel(key: string) {
  const date = new Date(`${key}T00:00:00Z`);
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 星期${weekdays[(date.getUTCDay() + 6) % 7]}`;
}

export function DateTimePicker({
  id,
  value,
  onChange,
  disabled,
  dateOnly = false,
  label,
  timezone = "Asia/Shanghai",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  dateOnly?: boolean;
  label?: string;
  timezone?: string;
}) {
  const initial = value.split("T");
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(initial[0] || zonedToday(timezone));
  const [month, setMonth] = useState(day.slice(0, 7));
  const [hour, setHour] = useState(initial[1]?.slice(0, 2) || "09");
  const [minute, setMinute] = useState(initial[1]?.slice(3, 5) || "00");
  const grid = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(false);
  const today = zonedToday(timezone);
  const first = `${month}-01`;
  const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = dateMove(first, -offset);
  const days = Array.from({ length: 42 }, (_, index) => dateMove(start, index));
  const validHour = /^\d{1,2}$/.test(hour) && Number(hour) <= 23;
  const validMinute = /^\d{1,2}$/.test(minute) && Number(minute) <= 59;
  useEffect(() => {
    if (shouldFocus.current) {
      grid.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${day}"]`)
        ?.focus();
      shouldFocus.current = false;
    }
  }, [day, month]);
  function select(key: string, focus = false) {
    shouldFocus.current = focus;
    setDay(key);
    setMonth(key.slice(0, 7));
  }
  function switchMonth(amount: number) {
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + amount);
    const nextMonth = dateKey(date).slice(0, 7);
    const last = new Date(date);
    last.setUTCMonth(last.getUTCMonth() + 1);
    last.setUTCDate(0);
    select(
      `${nextMonth}-${pad(Math.min(Number(day.slice(8)), last.getUTCDate()))}`,
      true,
    );
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const [date, time] = value.split("T");
          const key = date || today;
          setDay(key);
          setMonth(key.slice(0, 7));
          setHour(time?.slice(0, 2) || "09");
          setMinute(time?.slice(3, 5) || "00");
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          className="datetime-trigger"
          disabled={disabled}
          aria-label={
            label ||
            (dateOnly
              ? "日期"
              : timezone === "Asia/Shanghai"
                ? "时间（北京时间）"
                : `时间（${timezone}）`)
          }
        >
          <CalendarDays size={16} />
          <span>
            {value
              ? dateLabel(value.split("T")[0])
                  .replace(/^\d+年/, "")
                  .replace(" 星期", " 周")
              : "选择日期"}
          </span>
          {!dateOnly && <strong>{value.split("T")[1] || "--:--"}</strong>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="datetime-popover"
          side="right"
          align="center"
          sideOffset={8}
          collisionPadding={16}
          sticky="always"
          aria-label={dateOnly ? "选择日期" : "选择日期和时间"}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() =>
              grid.current
                ?.querySelector<HTMLButtonElement>(`[data-date="${day}"]`)
                ?.focus(),
            );
          }}
        >
          <div className="calendar-heading">
            <strong>
              {Number(month.slice(0, 4))}年{Number(month.slice(5))}月
            </strong>
            <div>
              <button
                type="button"
                aria-label="上个月"
                onClick={() => switchMonth(-1)}
              >
                <ChevronLeft size={17} />
              </button>
              <button
                type="button"
                aria-label="下个月"
                onClick={() => switchMonth(1)}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
          <div className="calendar-weekdays" aria-hidden="true">
            {weekdays.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-days" ref={grid} aria-label="选择日期">
            {days.map((key) => (
              <button
                key={key}
                type="button"
                data-date={key}
                data-outside={key.slice(0, 7) !== month}
                aria-label={dateLabel(key)}
                aria-pressed={day === key}
                aria-current={key === today ? "date" : undefined}
                tabIndex={day === key ? 0 : -1}
                onClick={() => select(key)}
                onKeyDown={(event) => {
                  const weekDay =
                    (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7;
                  const amounts: Record<string, number> = {
                    ArrowLeft: -1,
                    ArrowRight: 1,
                    ArrowUp: -7,
                    ArrowDown: 7,
                    Home: -weekDay,
                    End: 6 - weekDay,
                  };
                  if (event.key in amounts) {
                    event.preventDefault();
                    select(dateMove(key, amounts[event.key]), true);
                  }
                }}
              >
                {Number(key.slice(8))}
              </button>
            ))}
          </div>
          {!dateOnly && (
            <>
              <div className="calendar-time">
                <span>
                  <Clock3 size={15} />
                  时间
                </span>
                <div>
                  <input
                    aria-label="小时"
                    inputMode="numeric"
                    maxLength={2}
                    value={hour}
                    aria-invalid={!validHour}
                    onChange={(event) =>
                      setHour(event.target.value.replace(/\D/g, ""))
                    }
                    onBlur={() => {
                      if (validHour) setHour(pad(Number(hour)));
                    }}
                  />
                  <b>:</b>
                  <input
                    aria-label="分钟"
                    inputMode="numeric"
                    maxLength={2}
                    value={minute}
                    aria-invalid={!validMinute}
                    onChange={(event) =>
                      setMinute(event.target.value.replace(/\D/g, ""))
                    }
                    onBlur={() => {
                      if (validMinute) setMinute(pad(Number(minute)));
                    }}
                  />
                </div>
              </div>
              <div className="calendar-time-presets">
                {["09:00", "14:00", "20:00"].map((time) => (
                  <button
                    key={time}
                    type="button"
                    aria-pressed={
                      `${pad(Number(hour))}:${pad(Number(minute))}` === time
                    }
                    onClick={() => {
                      setHour(time.slice(0, 2));
                      setMinute(time.slice(3));
                    }}
                  >
                    {time}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="calendar-footer">
            <button type="button" onClick={() => select(today)}>
              今天
            </button>
            <Button
              size="sm"
              disabled={!dateOnly && (!validHour || !validMinute)}
              onClick={() => {
                onChange(
                  dateOnly
                    ? day
                    : `${day}T${pad(Number(hour))}:${pad(Number(minute))}`,
                );
                setOpen(false);
              }}
            >
              <Check size={14} />
              确定
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
