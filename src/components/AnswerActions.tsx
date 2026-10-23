import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Copy, Layers2 } from "lucide-react";
import { api, type RunEvent } from "@/lib/api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { RetrievalDebugger } from "./RetrievalDebugger";
import { ErrorNotice, Hint } from "./common";

function toolSummary(event: RunEvent): string {
  const result = event.data.result as Record<string, unknown> | undefined;
  if (!result) return "操作已完成";
  if (result.error) return String(result.error);
  if (result.exit_code !== undefined)
    return `脚本退出码：${result.exit_code}${result.stdout ? ` · ${String(result.stdout).slice(0, 180)}` : ""}`;
  if (result.summary) return String(result.summary).slice(0, 220);
  if (result.text) return String(result.text).slice(0, 220);
  if (result.structured_content)
    return JSON.stringify(result.structured_content).slice(0, 220);
  if (result.skipped) return String(result.skipped);
  if (result.needs_clarification) return "找到多个同名地点，等待确认";
  if (result.result !== undefined)
    return `结果：${String(result.result)}${result.to_unit ? ` ${result.to_unit}` : ""}`;
  if (result.datetime) return `${result.datetime} · ${result.weekday}`;
  if (result.current) {
    const current = result.current as Record<string, unknown>;
    const location = result.location as Record<string, unknown>;
    return `${location.name} · ${current.condition} · ${current.temperature_c}°C`;
  }
  if (Array.isArray(result.results))
    return `找到 ${result.results.length} 条来源，详见回答中的链接`;
  if (result.count !== undefined) return `找到 ${result.count} 条记录`;
  if (result.read) return "已读取网页正文";
  if (result.state === "candidate") return "已保存为候选记忆，等待确认";
  if (result.state === "confirmed") return "记忆已保存";
  if (result.title) return String(result.title);
  return "操作已完成";
}

export function AnswerActions({
  content,
  runId,
  runStatus,
  tools,
}: {
  content: string;
  runId?: string;
  runStatus?: string;
  tools?: RunEvent[];
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open || !runId) return;
    let live = true;
    setError("");
    if (tools !== undefined) {
      setEvents(tools);
      setLoading(false);
      return;
    }
    setLoading(true);
    setEvents([]);
    api<RunEvent[]>(`/runs/${runId}/tools`)
      .then((values) => {
        if (live) setEvents(values.filter((value) => value.kind === "tool"));
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, runId, tools]);
  async function copy() {
    setCopyError("");
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(content);
      else {
        const previous = document.activeElement as HTMLElement | null;
        const input = document.createElement("textarea");
        input.value = content;
        input.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(input);
        input.select();
        let success = false;
        try {
          success = document.execCommand("copy");
        } finally {
          input.remove();
          previous?.focus();
        }
        if (!success) throw new Error("copy failed");
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError("复制失败，请选择文字后复制。");
    }
  }
  return (
    <>
      <div className="answer-actions" role="group" aria-label="回答操作">
        <Hint label={copied ? "已复制" : "复制回答"}>
          <Button
            className="answer-action"
            size="icon"
            variant="ghost"
            aria-label={copied ? "已复制回答" : "复制回答"}
            disabled={!content}
            onClick={() => void copy()}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </Button>
        </Hint>
        {runId && (
          <>
            {(tools === undefined || tools.length > 0) && (
              <Hint
                label={
                  tools?.length
                    ? `工具调用结果 · ${tools.length} 项`
                    : "工具调用结果"
                }
              >
                <Button
                  className="answer-action"
                  size="icon"
                  variant="ghost"
                  aria-label="工具调用结果"
                  onClick={() => setOpen(true)}
                >
                  <Layers2 size={15} />
                </Button>
              </Hint>
            )}
            <RetrievalDebugger runId={runId} status={runStatus} compact />
          </>
        )}
        {copyError && (
          <span className="copy-error" role="alert">
            {copyError}
          </span>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="answer-tools-dialog">
          <DialogHeader>
            <DialogTitle>工具调用结果</DialogTitle>
            <DialogDescription>
              这次回答实际执行的工具与返回结果。
            </DialogDescription>
          </DialogHeader>
          <div className="answer-tools-body">
            {error && <ErrorNotice message={error} />}
            {loading ? (
              <p className="retrieval-empty">正在读取工具记录…</p>
            ) : !events.length ? (
              <p className="retrieval-empty">本轮没有工具调用记录。</p>
            ) : (
              <div className="tool-record-list">
                {events.map((event, index) => {
                  const result = event.data.result as
                    Record<string, unknown> | undefined;
                  const failed =
                    event.data.status === "error" || Boolean(result?.error);
                  const clarify = Boolean(result?.needs_clarification);
                  return (
                    <div
                      className={`tool-result ${failed ? "tool-result-failed" : ""}`}
                      key={index}
                    >
                      <span className="tool-result-symbol">
                        {failed || clarify ? (
                          <CircleAlert size={16} />
                        ) : (
                          <Check size={16} />
                        )}
                      </span>
                      <div className="tool-result-copy">
                        <div className="tool-result-title">
                          <strong>{String(event.data.name)}</strong>
                          {event.data.source === "mcp" && (
                            <small>{String(event.data.source_label)}</small>
                          )}
                          <span className="tool-result-meta">
                            {typeof event.data.duration_ms === "number" && (
                              <small>
                                {(event.data.duration_ms / 1000).toFixed(1)}s
                              </small>
                            )}
                            <span className="tool-result-state">
                              {event.data.status === "cancelled"
                                ? "已取消"
                                : failed
                                  ? "调用失败"
                                  : clarify
                                    ? "待确认"
                                    : "已返回"}
                            </span>
                          </span>
                        </div>
                        <p>{toolSummary(event)}</p>
                        {result &&
                          Boolean(
                            result.exit_code !== undefined ||
                            result.stdout ||
                            result.stderr,
                          ) && (
                            <details className="script-execution-details">
                              <summary>脚本执行详情</summary>
                              <p>
                                退出码：{String(result.exit_code ?? "未知")}
                              </p>
                              <pre>
                                {String(result.stdout || "")}
                                {result.stderr
                                  ? `\n错误输出：\n${String(result.stderr)}`
                                  : ""}
                              </pre>
                            </details>
                          )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
