import { SoftSelect } from "./ui/soft-select";
import { useEffect, useState } from "react";
import {
  Bookmark,
  ArrowUpRight,
  WandSparkles,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { dateTime } from "@/lib/utils";
import { api, type Memory, type Settings } from "@/lib/api";
import { ConfirmDelete, EmptyState, ErrorNotice } from "./common";
import { MemoryReview } from "./MemoryFeedback";
import { RetrievalDebugger } from "./RetrievalDebugger";

const categories: Record<string, string> = {
  fact: "个人事实",
  preference: "偏好",
  project: "项目状态",
};
export function MemoryPage({
  memories,
  memoryMode,
  refresh,
  createRequested,
  embedded = false,
}: {
  memories: Memory[];
  memoryMode: Settings["memory_mode"];
  refresh: () => Promise<void>;
  createRequested?: number;
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(createRequested));
  useEffect(() => {
    if (createRequested) setOpen(true);
  }, [createRequested]);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("fact");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const [detailId, setDetailId] = useState("");
  const detail = memories.find((value) => value.id === detailId);
  type Normalization = {
    id: string;
    revision: number;
    before: string;
    after: string;
  };
  const [normalizationOpen, setNormalizationOpen] = useState(false);
  const [proposals, setProposals] = useState<Normalization[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [memoryNotice, setMemoryNotice] = useState("");
  async function previewNormalization() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const values = await api<Normalization[]>(
        "/memories/normalization-preview",
      );
      setProposals(values);
      setSelected(new Set(values.map((value) => value.id)));
      setNormalizationOpen(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function applyNormalization() {
    if (busy) return;
    setBusy(true);
    setError("");
    const failed: Normalization[] = [];
    const errors: string[] = [];
    let saved = 0;
    for (const proposal of proposals.filter((value) =>
      selected.has(value.id),
    )) {
      const original = memories.find((value) => value.id === proposal.id);
      try {
        if (!original) throw new Error("这条记忆已不存在，请刷新后重试。");
        await api(`/memories/${proposal.id}`, "PUT", {
          content: proposal.after,
          category: original.category,
          source: original.source,
          state: "confirmed",
          revision: proposal.revision,
        });
        saved++;
      } catch (cause) {
        failed.push(proposal);
        errors.push((cause as Error).message);
      }
    }
    setProposals(failed);
    setSelected(new Set(failed.map((value) => value.id)));
    setMemoryNotice(
      `已整理 ${saved} 条记忆${failed.length ? `，${failed.length} 条未保存，请刷新后重新预览` : ""}。`,
    );
    if (!failed.length) setNormalizationOpen(false);
    try {
      await refresh();
    } catch {
      errors.push("列表暂未刷新，已保存的修改仍然有效。");
    }
    setError([...new Set(errors)].join("；"));
    setBusy(false);
  }
  async function changeMode(mode: Settings["memory_mode"]) {
    if (changingMode) return;
    setChangingMode(true);
    setError("");
    try {
      await api("/settings/memory", "PATCH", { memory_mode: mode });
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setChangingMode(false);
    }
  }
  function edit(value?: Memory) {
    setEditing(value || null);
    setContent(value?.content || "");
    setCategory(value?.category || "fact");
    setOpen(true);
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(
        editing ? `/memories/${editing.id}` : "/memories",
        editing ? "PUT" : "POST",
        {
          content,
          category,
          source: editing?.source || "用户手动记录",
          state: "confirmed",
          revision: editing?.revision,
        },
      );
      await refresh();
      setOpen(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    try {
      await api(`/memories/${deleting.id}`, "DELETE");
      await refresh();
      setDeleting(null);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const candidates = memories.filter(
    (x) => x.state === "candidate" && x.content.includes(query),
  );
  const values = memories.filter(
    (x) => x.state === "confirmed" && x.content.includes(query),
  );
  return (
    <div className={embedded ? "memory-settings" : "page-content"}>
      <div className="memory-page-heading">
        <div className="memory-title">
          <div className="memory-title-row">
            {embedded ? <h2>记忆</h2> : <h1>记忆</h1>}
            {memories.length > 0 && (
              <span className="memory-count">{memories.length}</span>
            )}
          </div>
          <p>
            查看、修改或删除XiaoXi记住的信息。向量检索只为这里的已生效记忆建立索引，没有额外的隐藏记忆。
          </p>
        </div>
        <Button onClick={() => edit()}>
          <Plus size={16} />
          添加记忆
        </Button>
      </div>
      {error && <ErrorNotice message={error} />}
      {memoryNotice && (
        <p className="memory-normalization-notice" role="status">
          {memoryNotice}
        </p>
      )}
      {candidates.length > 0 && (
        <section className="candidate-section">
          <h2>
            等待你确认 <span>{candidates.length}</span>
          </h2>
          {candidates.map((value) => (
            <MemoryReview key={value.id} memory={value} refresh={refresh} />
          ))}
        </section>
      )}
      <div className="memory-toolbar">
        <div className="search-field memory-search">
          <Search size={17} />
          <Input
            aria-label="搜索记忆"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索已记住的内容…"
          />
        </div>
        <div className="memory-toolbar-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void previewNormalization()}
          >
            <WandSparkles size={15} />
            一键整理表述
          </Button>
          <RetrievalDebugger />
          <label className="memory-mode-control">
            <span>保存方式</span>
            <SoftSelect
              label="记忆保存方式"
              value={memoryMode}
              onValueChange={(v) =>
                void changeMode(v as Settings["memory_mode"])
              }
              disabled={changingMode}
              options={[
                { value: "auto", label: "自动记忆" },
                { value: "confirm", label: "每次确认" },
              ]}
            />
          </label>
        </div>
      </div>
      {values.length ? (
        <div className="memory-grid">
          {values.map((value) => (
            <article className="memory-card" key={value.id}>
              <div className="memory-card-top">
                <span className="small-label">
                  {categories[value.category]}
                </span>
                <div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="编辑记忆"
                    onClick={() => edit(value)}
                  >
                    <Pencil size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="删除记忆"
                    onClick={() => setDeleting(value)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              </div>
              <p className="memory-content">{value.content}</p>
              <div className="memory-card-footer">
                <button
                  type="button"
                  className="memory-detail-toggle"
                  onClick={() => setDetailId(value.id)}
                >
                  查看详情
                  <ArrowUpRight size={13} aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Bookmark}
          title={query ? "没有匹配的记忆" : "从一件你想让XiaoXi记住的事开始"}
          action={
            !query && (
              <Button variant="outline" onClick={() => edit()}>
                <Plus size={15} />
                记录第一条记忆
              </Button>
            )
          }
        >
          {query
            ? "换一个关键词试试。"
            : "你的偏好、正在做的项目、最近的目标，都可以放在这里。"}
        </EmptyState>
      )}
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(value) => {
          if (!value) setDetailId("");
        }}
      >
        <DialogContent className="memory-detail-dialog">
          <DialogHeader>
            <DialogTitle>记忆详情</DialogTitle>
            <DialogDescription>
              {detail ? categories[detail.category] : ""}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <>
              <p className="memory-detail-content">{detail.content}</p>
              <p className="muted">最近更新：{dateTime(detail.updated_at)}</p>
              <section className="memory-provenance" aria-label="记忆来源">
                <h3>来源</h3>
                <p>{detail.source || "来源未记录"}</p>
                {detail.evidence ? (
                  <blockquote>{detail.evidence}</blockquote>
                ) : (
                  <p className="muted">这条记忆没有保留来源原话。</p>
                )}
              </section>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDetailId("");
                    setDeleting(detail);
                  }}
                >
                  <Trash2 size={15} />
                  删除
                </Button>
                <Button
                  onClick={() => {
                    setDetailId("");
                    edit(detail);
                  }}
                >
                  <Pencil size={15} />
                  编辑记忆
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={normalizationOpen}
        onOpenChange={(value) => {
          if (!busy) setNormalizationOpen(value);
        }}
      >
        <DialogContent className="memory-normalization-dialog">
          <DialogHeader>
            <DialogTitle>整理记忆表述</DialogTitle>
            <DialogDescription>
              清理命令语，保留事实、原话和来源。勾选要保存的修改，不会调用模型。
            </DialogDescription>
          </DialogHeader>
          {error && <ErrorNotice message={error} />}
          <div className="memory-normalization-list">
            {proposals.length ? (
              proposals.map((proposal) => (
                <label className="memory-normalization-item" key={proposal.id}>
                  <Checkbox
                    checked={selected.has(proposal.id)}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (checked === true) next.add(proposal.id);
                        else next.delete(proposal.id);
                        return next;
                      })
                    }
                  />
                  <span>
                    <small>整理前</small>
                    <p>{proposal.before}</p>
                    <small>整理后</small>
                    <p>{proposal.after}</p>
                  </span>
                </label>
              ))
            ) : (
              <p className="muted">当前没有需要整理的表述。</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setNormalizationOpen(false)}
            >
              关闭
            </Button>
            <Button
              disabled={busy || !selected.size}
              onClick={() => void applyNormalization()}
            >
              {busy ? "正在保存…" : `保存所选 ${selected.size} 条`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "编辑记忆" : "添加记忆"}</DialogTitle>
            <DialogDescription>
              保存具体、准确的信息，之后的交流会参考这些内容。
            </DialogDescription>
          </DialogHeader>
          {error && <ErrorNotice message={error} />}
          <div className="form-field">
            <Label htmlFor="memory-content">想记住什么</Label>
            <Textarea
              id="memory-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="例如：我喜欢先了解总体框架，再通过练习逐步学习。"
              rows={5}
            />
          </div>
          <div className="form-field">
            <Label htmlFor="memory-category">类型</Label>
            <SoftSelect
              id="memory-category"
              label="类型"
              value={category}
              onValueChange={setCategory}
              options={Object.entries(categories).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!content.trim() || busy}
              onClick={() => void save()}
            >
              {busy ? "正在保存…" : "保存记忆"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        open={Boolean(deleting)}
        title="删除这条记忆？"
        description="删除后，记忆记录不会再作为后续交流的个人背景。历史对话仍会保留。"
        label="删除记忆"
        error={error}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
      />
    </div>
  );
}
