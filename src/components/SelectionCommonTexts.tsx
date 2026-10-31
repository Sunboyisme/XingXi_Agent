import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Plus, Pencil, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCopyFeedback } from "@/lib/clipboard";
import {
  useCommonTextsRevision,
  type CommonText,
  type TextCategory,
} from "@/lib/commonTexts";
import { errorMessage } from "@/lib/utils";
import { ErrorNotice } from "./common";
import { CommonTextEditor } from "./CommonTextEditor";
import { CommonTextContent } from "./CommonTextContent";
import { documentImages, documentFor } from "@/lib/commonTextDocument";
import { Input } from "./ui/input";
import { SoftSelect } from "./ui/soft-select";

export function SelectionCommonTexts({
  onBack,
  onManage,
  onClose,
}: {
  onBack?: () => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const [editor, setEditor] = useState<{ value?: CommonText; key: number }>();
  const [notice, setNotice] = useState("");
  const [texts, setTexts] = useState<CommonText[]>([]);
  const [categories, setCategories] = useState<TextCategory[]>([]);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLocaleLowerCase());
  const [category, setCategory] = useState("all");
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const revision = useCommonTextsRevision();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void Promise.all([
      api<CommonText[]>("/common-texts?sort=updated", "GET", undefined, {
        signal: controller.signal,
      }),
      api<TextCategory[]>("/common-text-categories", "GET", undefined, {
        signal: controller.signal,
      }),
    ])
      .then(([items, groups]) => {
        if (controller.signal.aborted) return;
        setTexts(items);
        setCategories(groups);
        setCategory((value) =>
          value === "all" ||
          value === "uncategorized" ||
          groups.some((group) => group.id === value)
            ? value
            : "all",
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, retry]);
  const groupNames = useMemo(
    () => new Map(categories.map((group) => [group.id, group.name])),
    [categories],
  );
  const groupName = (value: CommonText) =>
    groupNames.get(value.category_id || "") || "默认分类";
  const filtered = useMemo(
    () =>
      texts.filter(
        (value) =>
          (category === "all" ||
            (category === "uncategorized"
              ? !value.category_id
              : value.category_id === category)) &&
          (!search ||
            `${groupNames.get(value.category_id || "") || "默认分类"}\n${value.content}`
              .toLocaleLowerCase()
              .includes(search)),
      ),
    [texts, category, search, groupNames],
  );
  const selected =
    filtered.find((value) => value.id === selectedId) || filtered[0];
  const copied = useCopyFeedback(selected?.content || "");
  return (
    <section className="selection-texts" aria-label="常用文本">
      <header className="selection-texts-heading">
        {onBack && <button onClick={onBack}>
          <ArrowLeft size={16} />
          返回划词
        </button>}
        <strong>常用文本</strong>
        <button onClick={() => { setNotice(""); setEditor({ key: Date.now() }); }}><Plus size={15} />新增</button>
        <button onClick={onManage}>
          <ExternalLink size={15} />
          管理
        </button>
        <button aria-label="关闭常用文本" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <div className="selection-texts-filters">
        <Input
          aria-label="搜索常用文本"
          placeholder="搜索文本或分类"
          maxLength={500}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SoftSelect
          label="文本分类"
          value={category}
          onValueChange={setCategory}
          options={[
            { value: "all", label: "全部分类" },
            { value: "uncategorized", label: "默认分类" },
            ...categories.map((group) => ({
              value: group.id,
              label: group.name,
            })),
          ]}
        />
      </div>
      {error && (
        <ErrorNotice
          message={error}
          retry={() => setRetry((value) => value + 1)}
        />
      )}
      {loading ? (
        <p className="selection-texts-empty" role="status">
          正在读取常用文本…
        </p>
      ) : filtered.length ? (
        <div className="selection-texts-browser">
          <nav className="selection-texts-list" aria-label="选择常用文本">
            {filtered.map((value) => (
              <button
                key={value.id}
                aria-pressed={selected?.id === value.id}
                onClick={() => setSelectedId(value.id)}
              >
                <small>{groupName(value)}</small>
                <span>
                  {value.content.trim().split(/\r?\n/, 1)[0].slice(0, 100) || `图片 · ${documentImages(documentFor(value)).length} 张`}
                </span>
              </button>
            ))}
          </nav>
          <article className="selection-texts-preview">
            <div
              className="selection-texts-content"
              tabIndex={0}
              aria-label="文本全文"
            >
              {selected && <CommonTextContent value={selected} />}
            </div>
            {copied.error && <ErrorNotice message={copied.error} />}
            <footer>
              <button onClick={() => setEditor({ value: selected, key: Date.now() })}><Pencil size={15} />编辑</button>
              <button disabled={!selected?.content} onClick={() => void copied.copy()}>
                {copied.copied ? <Check size={16} /> : <Copy size={16} />}
                {copied.copied ? "已复制" : "复制全文"}
              </button>
            </footer>
          </article>
        </div>
      ) : (
        <div className="selection-texts-empty">
          <p>{texts.length ? "没有匹配的文本" : "还没有常用文本"}</p>
          {!texts.length && !error && (
            <button onClick={() => setEditor({ key: Date.now() })}>添加常用文本</button>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {editor && <CommonTextEditor key={editor.key} value={editor.value} initialCategory={category !== "all" ? category : undefined}
        onClose={() => setEditor(undefined)} onSaved={saved => { setEditor(undefined); setSelectedId(saved.id); setCategory(saved.category_id || "uncategorized"); setQuery(""); setNotice("常用文本已保存"); }} />}
    </section>
  );
}
