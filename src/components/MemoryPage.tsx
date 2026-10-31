import { SoftSelect } from "./ui/soft-select";
import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ArrowUpRight,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { dateTime, errorMessage } from "@/lib/utils";
import { api, type Memory, type Settings } from "@/lib/api";
import { ConfirmDelete, EmptyState, ErrorNotice, Toast } from "./common";
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
}: {
  memories: Memory[];
  memoryMode: Settings["memory_mode"];
  refresh: () => Promise<void>;
  createRequested?: number;
}) {
  const [open, setOpen] = useState(Boolean(createRequested));
  useEffect(() => {
    if (createRequested) edit();
  }, [createRequested]);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("fact");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mutationLock = useRef(false);
  const [notice, setNotice] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [deleting, setDeleting] = useState<Memory | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const [detailId, setDetailId] = useState("");
  const detail = memories.find((value) => value.id === detailId);
  async function changeMode(mode: Settings["memory_mode"]) {
    if (changingMode) return;
    setChangingMode(true);
    setError("");
    try {
      await api("/settings/memory", "PATCH", { memory_mode: mode });
      await refreshAfterChange("记忆保存方式已更新");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setChangingMode(false);
    }
  }
  function edit(value?: Memory) {
    if (mutationLock.current) return;
    setError("");
    setEditing(value || null);
    setContent(value?.content || "");
    setCategory(value?.category || "fact");
    setOpen(true);
  }
  async function refreshAfterChange(message: string) {
    setSyncWarning("");
    try {
      await refresh();
    } catch {
      setSyncWarning(`${message}，列表暂未刷新，请重试刷新。`);
    }
  }
  async function save() {
    if (mutationLock.current || !content.trim()) return;
    mutationLock.current = true;
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
      setOpen(false);
      setEditing(null);
      setNotice("记忆已保存");
      await refreshAfterChange("记忆已保存");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting || mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/memories/${deleting.id}`, "DELETE");
      setDeleting(null);
      if (detailId === deleting.id) setDetailId("");
      setNotice("记忆已删除");
      await refreshAfterChange("记忆已删除");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  const candidates = memories.filter(
    (x) => x.state === "candidate" && x.content.includes(query),
  );
  const values = memories.filter(
    (x) => x.state === "confirmed" && x.content.includes(query),
  );
  return (
    <div className="memory-settings">
      <div className="memory-page-heading">
        <div className="memory-title">
          <div className="memory-title-row">
            <h2>记忆</h2>
            {memories.length > 0 && (
              <span className="memory-count">{memories.length}</span>
            )}
          </div>
          <p>
            查看、修改或删除XiaoXi记住的信息。向量检索只为这里的已生效记忆建立索引，没有额外的隐藏记忆。
          </p>
        </div>
        <Button disabled={busy} onClick={() => edit()}>
          <Plus size={16} />
          添加记忆
        </Button>
      </div>
      {notice && <Toast message={notice} onClose={() => setNotice("")} />}
      {error && !open && !deleting && (
        <ErrorNotice message={error} onClose={() => setError("")} />
      )}
      {syncWarning && (
        <ErrorNotice
          tone="warning"
          message={syncWarning}
          retry={() => void refreshAfterChange("修改已保存")}
          onClose={() => setSyncWarning("")}
        />
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
                  {value.project_id && " · 项目记忆"}
                </span>
                <div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="编辑记忆"
                    disabled={busy}
                    onClick={() => edit(value)}
                  >
                    <Pencil size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-delete-action
                    aria-label="删除记忆"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setDeleting(value);
                    }}
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
                  disabled={busy}
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
              <Button variant="outline" disabled={busy} onClick={() => edit()}>
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
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    setDetailId("");
                    setDeleting(detail);
                  }}
                  data-delete-action
                >
                  <Trash2 size={15} />
                  删除
                </Button>
                <Button
                  disabled={busy}
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
        open={open}
        onOpenChange={(value) => {
          if (!mutationLock.current) setOpen(value);
        }}
      >
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
              disabled={busy}
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
              disabled={busy}
              onValueChange={setCategory}
              options={Object.entries(categories).map(([value, label]) => ({
                value,
                label,
              }))}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
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
        onClose={() => {
          if (!mutationLock.current) setDeleting(null);
        }}
        onConfirm={remove}
      />
    </div>
  );
}
