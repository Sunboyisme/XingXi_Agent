import { BookOpen } from "lucide-react";
import { useState } from "react";
import { DetailDialog } from "./ui/detail-dialog";
export type KnowledgeSource = {
  document_id: string;
  chunk_id: string;
  relative_path: string;
  locator: string;
  excerpt: string;
};
export function KnowledgeSources({ sources }: { sources?: KnowledgeSource[] }) {
  const [open, setOpen] = useState(false);
  if (!sources?.length) return null;
  return (
    <DetailDialog
      open={open}
      onOpenChange={setOpen}
      title="知识库来源"
      label={
        <>
          <BookOpen size={15} />
          知识库来源 · {sources.length}
        </>
      }
      className="knowledge-source-list"
    >
      <p className="module-caption">本次参考的相关片段</p>
      {sources.map((source) => (
        <button
          className="knowledge-source"
          key={source.chunk_id}
          onClick={() => {
            setOpen(false);
            window.dispatchEvent(
              new CustomEvent("xiaoxi-open-knowledge", { detail: source }),
            );
          }}
        >
          <strong>{source.relative_path}</strong>
          <small>{source.locator}</small>
          <p>{source.excerpt.slice(0, 500)}</p>
          <span>打开文件</span>
        </button>
      ))}
    </DetailDialog>
  );
}
