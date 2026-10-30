import { DetailDialog } from "./ui/detail-dialog";
import { ASSISTANT_NAME } from "@/lib/brand";
import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Clock3,
  Database,
  ListFilter,
  Loader2,
  ScanSearch,
  Search,
} from "lucide-react";
import { api } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ErrorNotice, Hint } from "./common";
import { errorMessage } from "@/lib/utils";

type Trace = components["schemas"]["RetrievalRead"];
export function RetrievalDebugger({
  runId,
  status,
  compact = false,
}: {
  runId?: string;
  status?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [traces, setTraces] = useState<Trace[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!open || !runId) return;
    let live = true;
    setError("");
    setTraces([]);
    setActive(0);
    setBusy(true);
    api<Trace[]>(`/runs/${runId}/retrieval`)
      .then((values) => {
        if (live) setTraces(values);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [open, runId, status]);
  async function preview() {
    setBusy(true);
    setError("");
    try {
      const trace = await api<Trace>("/memories/retrieval/preview", "POST", {
        query: query.trim(),
      });
      setTraces([trace]);
      setActive(0);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const trace = traces[active];
  const selected = trace?.candidates.filter((candidate) => candidate.selected);
  const duration =
    trace && trace.duration_ms < 1
      ? "不到 1 毫秒"
      : trace
        ? `${trace.duration_ms} 毫秒`
        : "";
  const method = trace?.mode === "hybrid" ? "文字 + 语义匹配" : "文字匹配";
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return (
    <>
      <Hint label={runId ? "参考的记忆" : "试着查找记忆"}>
        <Button
          size={compact ? "icon" : "sm"}
          variant="ghost"
          className={compact ? "answer-action" : "retrieval-entry"}
          aria-label={runId ? "参考的记忆" : "试着查找记忆"}
          onClick={() => setOpen(true)}
        >
          <ListFilter size={15} />
          {!compact && (runId ? "参考的记忆" : "试着查找记忆")}
        </Button>
      </Hint>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="retrieval-dialog">
          <DialogHeader>
            <DialogTitle>
              {runId ? "这次回答查看了哪些记忆" : "测试记忆查找"}
            </DialogTitle>
            <DialogDescription>
              {runId
                ? "仅展示这次回答保存下来的查找记录，以及真正被采用的记忆。"
                : `输入一个可能的问题，看看 ${ASSISTANT_NAME} 会从已保存的记忆中找到哪些内容。`}
            </DialogDescription>
          </DialogHeader>
          {!runId && (
            <form
              className="retrieval-query"
              onSubmit={(e) => {
                e.preventDefault();
                if (query.trim() && !busy) void preview();
              }}
            >
              <Input
                aria-label="检索测试问题"
                value={query}
                maxLength={4000}
                placeholder="例如：我希望你回答得言简意赅"
                disabled={busy}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button disabled={busy || !query.trim()} type="submit">
                {busy ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Search size={15} />
                )}
                查找
              </Button>
            </form>
          )}
          {error && <ErrorNotice message={error} />}
          {busy && (
            <p className="retrieval-empty" role="status">
              正在查找相关记忆…
            </p>
          )}
          {traces.length > 1 && (
            <div
              className="retrieval-tabs"
              role="tablist"
              aria-label="检索记录"
            >
              {traces.map((value, index) => (
                <button
                  role="tab"
                  key={index}
                  aria-selected={active === index}
                  onClick={() => setActive(index)}
                >
                  {value.purpose === "context"
                    ? "回答前"
                    : `对话中第 ${index} 次`}
                </button>
              ))}
            </div>
          )}
          {!busy && trace && (
            <div className="retrieval-results">
              <section
                className={`retrieval-result-summary ${trace.selected_ids.length ? "" : "is-empty"}`}
              >
                <span className="retrieval-result-icon">
                  {trace.selected_ids.length ? (
                    <CheckCircle2 size={20} />
                  ) : (
                    <ScanSearch size={20} />
                  )}
                </span>
                <div>
                  <h3>
                    {trace.selected_ids.length
                      ? `找到 ${trace.selected_ids.length} 条可以参考的记忆`
                      : "这次没有找到合适的记忆"}
                  </h3>
                  <p>
                    {trace.selected_ids.length
                      ? `下面这些内容会被加入回答背景，帮助 ${ASSISTANT_NAME} 更贴近你的习惯和情况。`
                      : "本次不会向回答中加入记忆背景，也不会凭空补写内容。"}
                  </p>
                </div>
              </section>
              <section className="retrieval-query-card">
                <span>用于查找的原话</span>
                <p>{trace.query}</p>
              </section>
              {trace.fallback_reason && (
                <section className="retrieval-method-note" role="status">
                  <ScanSearch size={16} />
                  <div>
                    <strong>当前使用文字匹配</strong>
                    <p>
                      {trace.fallback_reason === "语义检索未启用"
                        ? "开启“按意思查找”后，即使你说法和记忆中的文字不同，也可能找到相关内容。"
                        : "按意思查找暂时不可用，因此这次只比较文字，不会猜测相近含义。"}
                    </p>
                  </div>
                </section>
              )}
              {selected && selected.length > 0 && (
                <section className="retrieval-selected">
                  <h3>会被参考的记忆</h3>
                  <div className="retrieval-candidates">
                    {selected.map((candidate) => (
                      <article
                        className="retrieval-candidate selected"
                        key={candidate.id}
                      >
                        <div className="retrieval-candidate-heading">
                          <span>
                            <Check size={13} />
                            已采用
                          </span>
                          <small>第 {candidate.revision} 版</small>
                        </div>
                        <p>{candidate.content}</p>
                        <small className="retrieval-candidate-source">
                          来自：{candidate.source}
                        </small>
                      </article>
                    ))}
                  </div>
                </section>
              )}
              <DetailDialog
                title="查找细节"
                className="retrieval-technical"
                label={
                  <>
                    <span>查看查找细节</span>
                  </>
                }
              >
                <div className="retrieval-metric-grid">
                  <div>
                    <Database size={15} />
                    <span>已建立索引</span>
                    <strong>
                      {trace.indexed} / {trace.total} 条
                    </strong>
                  </div>
                  <div>
                    <ScanSearch size={15} />
                    <span>查找方式</span>
                    <strong>{method}</strong>
                  </div>
                  <div>
                    <Clock3 size={15} />
                    <span>本次耗时</span>
                    <strong>{duration}</strong>
                  </div>
                  <div>
                    <Check size={15} />
                    <span>回答篇幅</span>
                    <strong>
                      {trace.tokens_used} / {trace.token_budget}
                    </strong>
                  </div>
                </div>
                <p className="retrieval-technical-note">
                  只查找记忆页中的已生效内容；未建立索引的记忆不会参与本次查找。
                  {trace.mode === "hybrid"
                    ? ` 语义相近的最低门槛为 ${percent(trace.threshold)}。`
                    : ""}
                </p>
                {trace.candidates.map((candidate) => (
                  <article className="retrieval-candidate" key={candidate.id}>
                    <div className="retrieval-candidate-heading">
                      <strong>{candidate.source}</strong>
                      <span>{candidate.selected ? "已采用" : "未采用"}</span>
                    </div>
                    <p>{candidate.content}</p>
                    <dl className="retrieval-score-list">
                      <div>
                        <dt>文字重合</dt>
                        <dd>{percent(candidate.keyword_score)}</dd>
                      </div>
                      <div>
                        <dt>含义相近</dt>
                        <dd>
                          {candidate.semantic_score == null
                            ? "未计算"
                            : percent(candidate.semantic_score)}
                        </dd>
                      </div>
                      <div>
                        <dt>版本</dt>
                        <dd>第 {candidate.revision} 版</dd>
                      </div>
                    </dl>
                    <code className="retrieval-candidate-id">
                      {candidate.id}
                    </code>
                  </article>
                ))}
              </DetailDialog>
            </div>
          )}
          {!busy && !trace && !error && (
            <p className="retrieval-empty">
              {runId
                ? "这条旧回答没有留下记忆查找记录，也不会事后补造。"
                : "输入一个问题后，这里会展示查找结果。"}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
