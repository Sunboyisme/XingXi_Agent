import { ChevronDown, Loader2 } from "lucide-react";
import type { ComplexTask } from "@/lib/api";
import { Hint } from "./ui/hint";

export function CurrentTaskSummary({
  task,
  queued,
}: {
  task: ComplexTask;
  queued: boolean;
}) {
  const current =
    task.steps.find((step) => step.status === "running") ||
    task.steps.find((step) => step.status === "pending");
  const completed = task.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const labels: Record<string, string> = {
    planning: "正在安排步骤",
    running: "执行中",
    waiting_input: "等待补充",
    paused: "已暂停",
  };
  return (
    <details className="current-task-summary">
      <summary>
        {["planning", "running"].includes(task.status) && (
          <Loader2 size={15} className="spin" />
        )}
        <Hint label={task.title}>
          <strong tabIndex={0}>{queued ? "正在处理新消息" : task.title}</strong>
        </Hint>
        <span>
          {queued
            ? "当前操作结束后判断归属"
            : current?.title || labels[task.status]}
        </span>
        <small>
          {completed}/{task.steps.length}
        </small>
        <ChevronDown size={15} />
      </summary>
      <div className="current-task-summary-body">
        <p>
          {labels[task.status]}
          {task.reason ? ` · ${task.reason}` : ""}
        </p>
        <ol>
          {task.steps.map((step) => (
            <li key={step.id} data-status={step.status}>
              {step.title}
              <span>
                {step.status === "completed"
                  ? "已完成"
                  : step.status === "running"
                    ? "进行中"
                    : step.status === "waiting"
                      ? "待确认"
                      : "待处理"}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
