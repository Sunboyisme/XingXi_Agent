import type { ComponentPropsWithoutRef } from "react";
import { Check, Copy } from "lucide-react";
import { useCopyFeedback } from "@/lib/clipboard";
import { Hint } from "./ui/hint";

type ContentNode = {
  type?: string;
  tagName?: string;
  value?: string;
  children?: ContentNode[];
};
function nodeText(node?: ContentNode): string {
  if (!node) return "";
  if (node.tagName === "br") return "\n";
  return node.value ?? node.children?.map(nodeText).join("") ?? "";
}
function tableRows(node?: ContentNode): string[][] {
  if (!node) return [];
  if (node.tagName === "tr") {
    const cells = (node.children || []).filter(
      (child) => child.tagName === "td" || child.tagName === "th",
    );
    return cells.length
      ? [
          cells.map((child) =>
            nodeText(child)
              .replace(/[\t\r\n]+/g, " ")
              .trim(),
          ),
        ]
      : [];
  }
  return (node.children || []).flatMap(tableRows);
}
function CopyBlockButton({ text, label }: { text: string; label: string }) {
  const { copied, error, copy } = useCopyFeedback(text);
  return (
    <>
      <Hint label={error || (copied ? "已复制" : label)}>
        <button
          type="button"
          className="markdown-block-copy"
          aria-label={copied ? "已复制" : label}
          onClick={() => void copy()}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </Hint>
      {error && (
        <small className="markdown-copy-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}
export function CodeBlock({
  node,
  children,
  ...props
}: ComponentPropsWithoutRef<"pre"> & { node?: ContentNode }) {
  const code = node?.children?.find((child) => child.tagName === "code");
  return (
    <section className="markdown-code-block">
      <div className="markdown-block-toolbar">
        <span>代码</span>
        <CopyBlockButton text={nodeText(code || node)} label="复制代码" />
      </div>
      <pre {...props}>{children}</pre>
    </section>
  );
}
export function TableBlock({
  node,
  children,
  ...props
}: ComponentPropsWithoutRef<"table"> & { node?: ContentNode }) {
  return (
    <section className="markdown-table-block">
      <div className="markdown-block-toolbar">
        <span>表格</span>
        <CopyBlockButton
          text={tableRows(node)
            .map((row) => row.join("\t"))
            .join("\n")}
          label="复制表格，可粘贴到Excel"
        />
      </div>
      <div className="markdown-table-scroll">
        <table {...props}>{children}</table>
      </div>
    </section>
  );
}
