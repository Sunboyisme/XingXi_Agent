import { DetailDialog } from "./ui/detail-dialog";
import { useState } from "react";
import {
  Check,
  ChevronDown,
  Circle,
  ClipboardList,
  Files,
  Loader2,
} from "lucide-react";
import { api, type ComplexTask } from "@/lib/api";
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
  running = false,
  onUpdate,
  onResume,
}: {
  task: ComplexTask;
  busy: boolean;
  running?: boolean;
  onUpdate: (task: ComplexTask) => void;
  onResume?: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
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
  const active = running && ["running", "planning"].includes(task.status);
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
    <section
      className="complex-task-card"
      aria-label={`任务：${task.title || "历史任务"}`}
    >
      <div className="complex-task-heading" data-expanded={open}>
        {active ? (
          <Loader2 size={16} className="spin" />
        ) : task.status === "completed" ? (
          <Check size={16} />
        ) : (
          <Circle size={16} />
        )}
        <strong title={task.title || "历史任务"}>
          {task.title || "历史任务"}
        </strong>
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
      {active && current && !open && (
        <p className="complex-task-current">{current.title}</p>
      )}
      {task.pending_messages > 0 && (
        <p role="status">已收到补充要求，当前步骤结束后处理。</p>
      )}
      {open && (
        <div className="complex-task-details" id={`task-details-${task.id}`}>
          <section className="task-detail-section">
            <h3>任务目标</h3>
            <p>{task.goal}</p>
          </section>
          {task.reason && !["completed", "cancelled"].includes(task.status) && (
            <p className="complex-task-reason">{task.reason}</p>
          )}
          <div className="complex-task-progress" role="status">
            {task.steps.length
              ? `已完成 ${completed} / ${task.steps.length} 个步骤`
              : task.status === "planning"
                ? "正在安排执行步骤。"
                : "暂无执行步骤，可查看已保存成果与实际操作记录。"}
            {task.steps.length > 0 && (
              <progress
                value={completed}
                max={task.steps.length}
                aria-label="任务完成进度"
              />
            )}
          </div>
          {!!task.requirements.constraints?.length && (
            <section className="task-detail-section">
              <h3>需求与约束</h3>
              <ul className="task-constraint-list">
                {task.requirements.constraints.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </section>
          )}
          {!!task.steps.length && (
            <section className="task-detail-section">
              <h3>执行步骤</h3>
              <ol className="complex-task-steps">
                {task.steps.map((step, index) => (
                  <li key={step.id} data-status={step.status}>
                    <span className="task-step-number">
                      {step.status === "completed" ? (
                        <Check size={13} />
                      ) : (
                        String(index + 1).padStart(2, "0")
                      )}
                    </span>
                    <span>{step.title}</span>
                    <small>{states[step.status] || step.status}</small>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {!!task.requirements.completion_criteria?.length && (
            <div className="complex-task-criteria">
              <h3>完成条件</h3>
              <ul>
                {task.requirements.completion_criteria.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {task.operations.length > 0 && (
            <DetailDialog
              title="实际操作记录"
              className="task-operation-records"
              label={
                <>
                  <ClipboardList size={15} />
                  <span>实际操作记录</span>
                  <small>{task.operations.length}</small>
                </>
              }
            >
              {task.operations.map((operation) => (
                <div className="complex-task-operation" key={operation.id}>
                  <div className="task-operation-title">
                    <strong>{operation.name || operation.tool_id}</strong>
                    <small data-status={operation.status}>
                      {states[operation.status] || operation.status}
                    </small>
                  </div>
                  {Boolean(
                    operation.result.error || operation.result.summary,
                  ) && (
                    <p>
                      {String(
                        operation.result.error || operation.result.summary,
                      )}
                    </p>
                  )}
                  <DetailDialog
                    title="操作详情"
                    className="task-operation-data"
                    label={<>查看详情</>}
                  >
                    <pre>{JSON.stringify(operation.result, null, 2)}</pre>
                  </DetailDialog>
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
            </DetailDialog>
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
      {error && <p role="alert">{error}</p>}
      {task.status === "paused" && onResume && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || saving}
          onClick={() => onResume(task.id)}
        >
          继续任务
        </Button>
      )}
    </section>
  );
}
