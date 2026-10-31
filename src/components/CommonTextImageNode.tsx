import { createContext, useContext, type DragEvent } from "react";
import { Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Pencil, Trash2 } from "lucide-react";
import { CommonTextPicture } from "./CommonTextContent";

export const CommonTextImageContext = createContext({
  inactive: true,
  edit: (_assetId: string, _getPos: () => number | undefined) => {},
});

function CommonTextImageView({
  node,
  getPos,
  deleteNode,
  selected,
}: NodeViewProps) {
  const { inactive, edit } = useContext(CommonTextImageContext);
  const assetId = String(node.attrs.assetId);
  return (
    <NodeViewWrapper
      className="common-text-image-node"
      contentEditable={false}
      draggable={false}
      data-selected={selected || undefined}
      onDragStart={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
    >
      <CommonTextPicture id={assetId}>
        {(asset) => (
          <>
            <button
              type="button"
              disabled={inactive}
              onClick={() => edit(asset.id, getPos)}
            >
              <Pencil size={14} />
              {asset.scene ? "重新编辑标注" : "编辑图片"}
            </button>
            <button
              type="button"
              disabled={inactive}
              data-delete-action
              onClick={deleteNode}
            >
              <Trash2 size={14} />
              移除图片
            </button>
          </>
        )}
      </CommonTextPicture>
    </NodeViewWrapper>
  );
}

export const CommonTextImageNode = Node.create({
  name: "commonTextImage",
  group: "block",
  atom: true,
  draggable: false,
  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-common-text-asset"),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: "figure[data-common-text-asset]",
        getAttrs: (element) =>
          /^[a-f0-9-]{36}$/.test(
            element.getAttribute("data-common-text-asset") || "",
          )
            ? null
            : false,
      },
    ];
  },
  renderHTML({ node }) {
    return ["figure", { "data-common-text-asset": node.attrs.assetId }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CommonTextImageView);
  },
});
