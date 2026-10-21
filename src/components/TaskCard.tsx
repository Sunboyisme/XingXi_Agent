import { useState } from "react";
import { Check, ChevronDown, Circle, Files, Loader2 } from "lucide-react";
import { api, type ComplexTask, type Run } from "@/lib/api";
import { ArtifactDownload, ArtifactPicture } from "./AnswerPresentation";
import { FileCard } from "./OfficeFiles";
import { Button } from "./ui/button";

const states: Record<string, string> = {
  planning: "正在安排步骤",
  running: "执行中",
  waiting_input: "等待你补充",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已结束",
  pending: "待处理",
  failed: "未完成",
  unknown: "结果待核实",
  started: "正在执行",
  skipped: "已跳过",
  superseded: "已更新",
  waiting: "待确认",
};

export function TaskCard({
  task,
  busy,
  onRun,
  onUpdate,
}: {
  task: ComplexTask;
  busy: boolean;
  onRun: (run: Run) => void;
  onUpdate: (task: ComplexTask) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const current =
    task.steps.find((step) => step.status === "running") ||
    task.steps.find((step) => step.status === "pending");
  const completed = task.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const files = [...task.artifacts].sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      b.task_revision - a.task_revision,
  );
  const currentCount = files.filter((file) => file.current).length;
  const active = busy && ["running", "planning"].includes(task.status);
  async function action(kind: "resume" | "cancel") {
    setSaving(true);
    setError("");
    try {
      if (kind === "resume")
        onRun(await api<Run>(`/tasks/${task.id}/resume`, "POST"));
      else onUpdate(await api<ComplexTask>(`/tasks/${task.id}/cancel`, "POST"));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function resolve(
    operationId: string,
    resolution: "retry" | "skip" | "completed",
  ) {
    setSaving(true);
    setError("");
    try {
      onUpdate(
        await api<ComplexTask>(`/tasks/${task.id}/resolve`, "POST", {
          operation_id: operationId,
          resolution,
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="complex-task-card" aria-label={`任务：${task.goal}`}>
      <div className="complex-task-heading" data-expanded={open}>
        {active ? (
          <Loader2 size={16} className="spin" />
        ) : task.status === "completed" ? (
          <Check size={16} />
        ) : (
          <Circle size={16} />
        )}
        <strong>{task.goal}</strong>
        <span>{states[task.status] || task.status}</span>
        <button
          type="button"
          className="task-details-toggle"
          aria-label={open ? "收起任务步骤" : "展开任务步骤"}
          aria-expanded={open}
          aria-controls={`task-details-${task.id}`}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown size={15} className="task-chevron" aria-hidden="true" />
        </button>
      </div>
      {active && current && (
        <p className="complex-task-current">{current.title}</p>
      )}
      {task.reason && <p className="complex-task-reason">{task.reason}</p>}
      {task.pending_messages > 0 && (
        <p role="status">已收到补充要求，当前步骤结束后处理。</p>
      )}
      {open && (
        <div className="complex-task-details" id={`task-details-${task.id}`}>
          <p className="complex-task-progress" role="status">
            {task.steps.length
              ? `已完成 ${completed} / ${task.steps.length} 个步骤`
              : task.status === "planning"
                ? "正在安排执行步骤，步骤生成后会显示在这里。"
                : "暂无执行步骤，可查看已保存成果与实际操作记录。"}
          </p>
          {!!task.requirements.constraints?.length && (
            <ul>
              {task.requirements.constraints.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )}
          <ol className="complex-task-steps">
            {task.steps.map((step) => (
              <li key={step.id} data-status={step.status}>
                <span>{step.title}</span>
                <small>{states[step.status] || step.status}</small>
              </li>
            ))}
          </ol>
          {!!task.requirements.completion_criteria?.length && (
            <div className="complex-task-criteria">
              <strong>完成条件</strong>
              <ul>
                {task.requirements.completion_criteria.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {task.operations.length > 0 && (
            <details>
              <summary>实际操作记录</summary>
              {task.operations.map((operation) => (
                <div className="complex-task-operation" key={operation.id}>
                  <strong>{operation.tool_id}</strong> ·{" "}
                  {states[operation.status] || operation.status}
                  {Boolean(
                    operation.result.error || operation.result.summary,
                  ) && (
                    <p>
                      {String(
                        operation.result.error || operation.result.summary,
                      )}
                    </p>
                  )}
                  {operation.status === "unknown" &&
                    task.status !== "cancelled" && (
                      <div className="complex-task-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || saving}
                          onClick={() =>
                            void resolve(operation.id, "completed")
                          }
                        >
                          已核实完成
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || saving}
                          onClick={() => void resolve(operation.id, "retry")}
                        >
                          核对后重新提交
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || saving}
                          onClick={() => void resolve(operation.id, "skip")}
                        >
                          跳过该操作
                        </Button>
                      </div>
                    )}
                </div>
              ))}
            </details>
          )}
        </div>
      )}
      {task.artifacts.length > 0 && (
        <div className="complex-task-files">
          <button
            type="button"
            className="task-files-toggle"
            aria-expanded={filesOpen}
            aria-controls={`task-files-${task.id}`}
            onClick={() => setFilesOpen((value) => !value)}
          >
            <Files size={17} aria-hidden="true" />
            <span>
              <strong>
                任务成果{" "}
                <span className="task-files-count">{files.length}</span>
              </strong>
              <small>
                {currentCount} 份当前成果
                {files.length > currentCount
                  ? ` · ${files.length - currentCount} 份历史成果`
                  : ""}
              </small>
            </span>
            <ChevronDown size={15} className="task-chevron" />
          </button>
          {filesOpen && (
            <div className="task-artifact-list" id={`task-files-${task.id}`}>
              {files.map((file) => (
                <article
                  className="task-artifact"
                  data-current={file.current}
                  key={file.id}
                >
                  <small className="task-artifact-version">
                    {file.current ? "当前成果" : "历史成果"} · 第{" "}
                    {file.task_revision} 版
                  </small>
                  {file.image ? (
                    <>
                      <ArtifactPicture artifact={file} />
                      <ArtifactDownload artifact={file} />
                    </>
                  ) : (
                    <FileCard file={file} />
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      )}
      {!["completed", "cancelled"].includes(task.status) && (
        <div className="complex-task-actions">
          {!busy && task.status !== "waiting_input" && (
            <Button
              size="sm"
              disabled={saving}
              onClick={() => void action("resume")}
            >
              继续任务
            </Button>
          )}
          {task.status === "waiting_input" && (
            <small>
              请在聊天中补充要求或确认；结果未知时可展开实际操作记录核实。
            </small>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => void action("cancel")}
          >
            结束任务
          </Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
