import { BookOpen } from "lucide-react";
import { DetailDialog } from "./ui/detail-dialog";
export type KnowledgeSource = {
  document_id: string;
  chunk_id: string;
  relative_path: string;
  locator: string;
  excerpt: string;
};
export function KnowledgeSources({ sources }: { sources?: KnowledgeSource[] }) {
  if (!sources?.length) return null;
  return (
    <DetailDialog
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
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("xiaoxi-open-knowledge", { detail: source }),
            )
          }
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
