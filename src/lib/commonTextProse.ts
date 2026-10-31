import type { JSONContent } from "@tiptap/core";
import type { CommonTextBlock, CommonTextDocument } from "./commonTextDocument";

/** Keep the stored v1 document while presenting one continuous editing surface. */
export function normalizeCommonTextDocument(
  value: CommonTextDocument,
): CommonTextDocument {
  const blocks: CommonTextBlock[] = [];
  for (const block of value.blocks) {
    const last = blocks.at(-1);
    if (block.type === "text" && last?.type === "text")
      last.text += `\n${block.text}`;
    else blocks.push({ ...block });
  }
  // The editor supplies a caret after a final image; it is not additional content.
  const tail = blocks.at(-1);
  if (blocks.length > 1 && tail?.type === "text" && tail.text === "")
    blocks.pop();
  return {
    version: 1,
    blocks: blocks.length ? blocks : [{ type: "text", text: "" }],
  };
}

export function commonTextToProse(document: CommonTextDocument): JSONContent {
  const content: JSONContent[] = document.blocks.map((block) => {
    if (block.type === "image")
      return { type: "commonTextImage", attrs: { assetId: block.asset_id } };
    const lines = block.text.split("\n");
    const text: JSONContent[] = [];
    lines.forEach((line, index) => {
      if (index) text.push({ type: "hardBreak" });
      if (line) text.push({ type: "text", text: line });
    });
    return { type: "paragraph", content: text };
  });
  return {
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  };
}

export function proseToCommonText(document: JSONContent): CommonTextDocument {
  const blocks: CommonTextBlock[] = [];
  for (const node of document.content || []) {
    if (
      node.type === "commonTextImage" &&
      typeof node.attrs?.assetId === "string"
    ) {
      blocks.push({ type: "image", asset_id: node.attrs.assetId });
    } else if (node.type === "paragraph") {
      blocks.push({
        type: "text",
        text: (node.content || [])
          .map((child) =>
            child.type === "hardBreak" ? "\n" : child.text || "",
          )
          .join(""),
      });
    }
  }
  return normalizeCommonTextDocument({ version: 1, blocks });
}
