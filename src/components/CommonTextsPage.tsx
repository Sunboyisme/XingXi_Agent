import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  FileText,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  notifyCommonTextsChanged,
  useCommonTextsRevision,
  type CommonText,
  type TextCategory,
} from "@/lib/commonTexts";
import { useCopyFeedback } from "@/lib/clipboard";
import { errorMessage } from "@/lib/utils";
import { CommonTextEditor } from "./CommonTextEditor";
import { TextCategoryManager } from "./TextCategoryManager";
import { ConfirmDelete, EmptyState, ErrorNotice, Hint, Toast } from "./common";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SoftSelect } from "./ui/soft-select";
import "../styles/common-texts.css";

function TextCard({
  value,
  category,
  onEdit,
  onDelete,
}: {
  value: CommonText;
  category: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const copy = useCopyFeedback(value.content);
  const long =
    value.content.length > 240 || value.content.split("\n").length > 4;
  return (
    <article className="common-text-card">
      <div className="common-text-card-meta">
        <span>{category}</span>
        <Hint
          label={
            <span>
              最近更新
              <br />
              {new Date(value.updated_at).toLocaleString()}
            </span>
          }
        >
          <time tabIndex={0} dateTime={value.updated_at}>
            {new Date(value.updated_at).toLocaleDateString()}
          </time>
        </Hint>
      </div>
      <div
        className={`common-text-body${long && !expanded ? " is-collapsed" : ""}`}
        tabIndex={0}
      >
        {value.content}
      </div>
      <div className="common-text-card-actions">
        {long && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "收起" : "展开全文"}
          </Button>
        )}
        <span className="common-text-action-spacer" />
        <Hint label={copy.copied ? "已复制" : "复制全文"}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copy.copied ? "已复制" : "复制全文"}
            onClick={() => void copy.copy()}
          >
            {copy.copied ? <Check size={16} /> : <Copy size={16} />}
          </Button>
        </Hint>
        <Hint label="编辑文本">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="编辑文本"
            onClick={onEdit}
          >
            <Pencil size={16} />
          </Button>
        </Hint>
        <Hint label="删除文本">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="删除文本"
            onClick={onDelete}
          >
            <Trash2 size={16} />
          </Button>
        </Hint>
      </div>
      {copy.copied && (
        <span className="sr-only" role="status">
          已复制全文
        </span>
      )}
      {copy.error && <ErrorNotice message={copy.error} />}
    </article>
  );
}

export function CommonTextsPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("category");
  const [rows, setRows] = useState<CommonText[]>([]);
  const [categories, setCategories] = useState<TextCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<{ value?: CommonText; key: number }>();
  const [manager, setManager] = useState(false);
  const [deleting, setDeleting] = useState<CommonText>();
  const [deleteError, setDeleteError] = useState("");
  const [toast, setToast] = useState("");
  const revision = useCommonTextsRevision();
  const mounted = useRef(false);
  const deleteLock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, sort });
      if (category !== "all") params.set("category_id", category);
      void Promise.allSettled([
        api<TextCategory[]>("/common-text-categories", "GET", undefined, {
          signal: controller.signal,
          timeoutMs: 10000,
        }),
        api<CommonText[]>(`/common-texts?${params}`, "GET", undefined, {
          signal: controller.signal,
          timeoutMs: 10000,
        }),
      ])
        .then(([groups, texts]) => {
          if (controller.signal.aborted) return;
          if (groups.status === "fulfilled") {
            setCategories(groups.value);
            if (
              category !== "all" &&
              category !== "uncategorized" &&
              !groups.value.some((row) => row.id === category)
            ) {
              setCategory("all");
              return;
            }
          }
          if (texts.status === "fulfilled") setRows(texts.value);
          const failures = [groups, texts].flatMap((result) =>
            result.status === "rejected" ? [errorMessage(result.reason)] : [],
          );
          if (failures.length) setError([...new Set(failures)].join("；"));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, category, sort, revision, reload]);
  const names = new Map(categories.map((row) => [row.id, row.name]));
  const groups = new Map<string, CommonText[]>();
  for (const row of rows) {
    const key =
      sort === "category" ? row.category_id || "uncategorized" : "recent";
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return (
    <section className="common-texts-page" aria-label="常用文本">
      <header className="common-texts-header">
        <h1>常用文本</h1>
      </header>
      <div className="common-texts-content">
        <div className="common-texts-toolbar">
          <div className="common-text-search">
            <Search size={17} />
            <Input
              aria-label="搜索正文或分类"
              placeholder="搜索正文或分类"
              value={query}
              maxLength={500}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <SoftSelect
            label="文本排序"
            value={sort}
            onValueChange={setSort}
            options={[
              { value: "category", label: "按分类" },
              { value: "updated", label: "最近更新" },
            ]}
          />
          <SoftSelect
            label="筛选分类"
            value={category}
            onValueChange={setCategory}
            options={[
              { value: "all", label: "全部分类" },
              { value: "uncategorized", label: "未分类" },
              ...categories.map((row) => ({ value: row.id, label: row.name })),
            ]}
          />
          <Button variant="outline" onClick={() => setManager(true)}>
            管理分类
          </Button>
          <Button onClick={() => setEditor({ key: Date.now() })}>
            <Plus size={17} />
            新增
          </Button>
        </div>
        {loading && (
          <p role="status" className="common-text-muted">
            正在读取常用文本…
          </p>
        )}
        {error && (
          <ErrorNotice message={error} retry={() => setReload((n) => n + 1)} />
        )}
        {!loading && !error && !rows.length && (
          <EmptyState
            icon={FileText}
            title={
              query || category !== "all"
                ? "没有找到匹配文本"
                : "保存常用的文字"
            }
            action={
              query || category !== "all" ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <Button onClick={() => setEditor({ key: Date.now() })}>
                  新增常用文本
                </Button>
              )
            }
          >
            {query || category !== "all"
              ? "试试其他关键词或分类。"
              : "可在这里新增，也可选中文字后通过划词助手收藏。"}
          </EmptyState>
        )}
        {!error &&
          [...groups].map(([key, texts]) => (
            <section
              className="common-text-group"
              key={key}
              aria-label={
                key === "recent" ? "最近更新" : names.get(key) || "未分类"
              }
            >
              {sort === "category" && (
                <h2>
                  {names.get(key) || "未分类"}
                  <span>{texts.length}</span>
                </h2>
              )}
              <div className="common-text-grid">
                {texts.map((row) => (
                  <TextCard
                    key={row.id}
                    value={row}
                    category={names.get(row.category_id || "") || "未分类"}
                    onEdit={() => setEditor({ value: row, key: Date.now() })}
                    onDelete={() => {
                      setDeleting(row);
                      setDeleteError("");
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
      </div>
      {editor && (
        <CommonTextEditor
          key={editor.key}
          value={editor.value}
          initialCategory={category !== "all" ? category : undefined}
          onClose={() => setEditor(undefined)}
          onSaved={() => {
            setEditor(undefined);
            setToast("常用文本已保存");
            setReload((n) => n + 1);
          }}
        />
      )}
      {manager && <TextCategoryManager onClose={() => setManager(false)} />}
      <ConfirmDelete
        open={Boolean(deleting)}
        title="删除常用文本？"
        description="删除后无法恢复，请确认这段文字不再需要。"
        label="删除文本"
        error={deleteError}
        onClose={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (!deleting || deleteLock.current) return;
          deleteLock.current = true;
          try {
            await api(`/common-texts/${deleting.id}`, "DELETE");
            notifyCommonTextsChanged();
            if (mounted.current) {
              setDeleting(undefined);
              setToast("文本已删除");
              setReload((n) => n + 1);
            }
          } catch (cause) {
            if (mounted.current) setDeleteError(errorMessage(cause));
          } finally {
            deleteLock.current = false;
          }
        }}
      />
      {toast && <Toast message={toast} onClose={() => setToast("")} />}
    </section>
  );
}
