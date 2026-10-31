import { invoke, isTauri } from "@tauri-apps/api/core";
import { fetchApi } from "./api";
import type { CaptureMark } from "./captureDrawing";

export type CommonTextBlock =
  { type: "text"; text: string } | { type: "image"; asset_id: string };
export type CommonTextDocument = { version: 1; blocks: CommonTextBlock[] };
export type DraftBlock = CommonTextBlock & { key: string };
export type CaptureScene = {
  version: 1;
  width: number;
  height: number;
  marks: CaptureMark[];
};
export type CommonTextAsset = {
  id: string;
  name: string;
  media_type: string;
  width: number;
  height: number;
  scene: CaptureScene | null;
};
export function documentFor(value?: {
  document?: CommonTextDocument | null;
  content: string;
}): CommonTextDocument {
  return (
    value?.document || {
      version: 1,
      blocks: [{ type: "text", text: value?.content || "" }],
    }
  );
}
export const draftBlocks = (document: CommonTextDocument): DraftBlock[] =>
  document.blocks.map((block) => ({ ...block, key: crypto.randomUUID() }));
export const serializeBlocks = (blocks: DraftBlock[]): CommonTextDocument => ({
  version: 1,
  blocks: blocks.map(({ key: _key, ...block }) => block),
});
export const documentText = (document: CommonTextDocument) =>
  document.blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
export const documentImages = (document: CommonTextDocument) =>
  document.blocks.flatMap((block) =>
    block.type === "image" ? [block.asset_id] : [],
  );

export async function uploadCommonTextImage(
  file: File,
  rendered?: Blob,
  scene?: CaptureScene,
): Promise<CommonTextAsset> {
  if (
    !/\.(png|jpe?g|webp)$/i.test(file.name) &&
    !["image/png", "image/jpeg", "image/webp"].includes(file.type)
  )
    throw new Error("请添加 PNG、JPG 或 WebP 图片");
  if (file.size > 32 * 1024 * 1024) throw new Error("单张图片不能超过 32 MB");
  const body = new FormData();
  body.append("file", file);
  if (rendered) body.append("rendered", rendered, "edited.png");
  if (scene) body.append("scene", JSON.stringify(scene));
  return (
    await fetchApi("/common-text-assets", { method: "POST", body })
  ).json();
}

export async function copyCommonTextImage(id: string) {
  if (isTauri()) {
    await invoke("common_text_copy_image", { assetId: id });
    return;
  }
  const blob = await (
    await fetchApi(`/common-text-assets/${id}/content`)
  ).blob();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export async function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("图片编码失败，请重试")),
      "image/png",
    ),
  );
}
