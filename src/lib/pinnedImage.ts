import type { MenuOptions } from "@tauri-apps/api/menu";

export type PinInfo = {
  dataUrl: string;
  originalUrl?: string | null;
  width: number;
  height: number;
  scale: number;
  revision: number;
  dpi: number;
};
export type PinGeometry = Pick<PinInfo, "scale" | "dpi">;
export const pinZoomLevels = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export async function loadPinCanvas(url: string) {
  if (!url.startsWith("data:image/png;base64,")) throw new Error("无效贴图");
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法打开图像画布");
  ctx.drawImage(image, 0, 0);
  return canvas;
}
export function processPinImage(source: HTMLCanvasElement, action: string) {
  if (
    ![
      "rotate-left",
      "rotate-right",
      "flip-x",
      "flip-y",
      "grayscale",
      "invert",
    ].includes(action)
  ) {
    throw new Error("未知图像处理操作");
  }
  const output = document.createElement("canvas");
  const rotate = action === "rotate-left" || action === "rotate-right";
  output.width = rotate ? source.height : source.width;
  output.height = rotate ? source.width : source.height;
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("无法处理图片");
  ctx.translate(output.width / 2, output.height / 2);
  if (rotate)
    ctx.rotate(action === "rotate-right" ? Math.PI / 2 : -Math.PI / 2);
  if (action === "flip-x") ctx.scale(-1, 1);
  if (action === "flip-y") ctx.scale(1, -1);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  if (action === "grayscale" || action === "invert") {
    const pixels = ctx.getImageData(0, 0, output.width, output.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const values = pixels.data;
      if (action === "invert") {
        values[i] = 255 - values[i];
        values[i + 1] = 255 - values[i + 1];
        values[i + 2] = 255 - values[i + 2];
      } else {
        const gray = Math.round(
          values[i] * 0.2126 + values[i + 1] * 0.7152 + values[i + 2] * 0.0722,
        );
        values[i] = values[i + 1] = values[i + 2] = gray;
      }
    }
    ctx.putImageData(pixels, 0, 0);
  }
  return output.toDataURL("image/png");
}
export function pinMenuItems(
  info: PinInfo,
  state: { editing: boolean; busy: boolean; shadow: boolean; opacity: number },
  dispatch: (action: string) => void,
): MenuOptions["items"] {
  const prefix = crypto.randomUUID();
  const item = (id: string, text: string, enabled = !state.busy) => ({
    id: `${prefix}:${id}`,
    text,
    enabled,
    action: () => dispatch(id),
  });
  const zoom = pinZoomLevels.map((value) => ({
    ...item(
      `zoom:${value}`,
      `${Math.round(value * 100)}%`,
      !state.busy && !state.editing,
    ),
    checked: Math.abs(info.scale - value) < 0.005,
  }));
  return [
    item("copy", "复制图像"),
    item("copy-original", "复制原始大小图像"),
    item("save", "图像另存为…"),
    { item: "Separator" },
    {
      ...item("annotate", state.editing ? "完成标注" : "标注"),
      checked: state.editing,
    },
    { ...item("shadow", "窗口阴影"), checked: state.shadow },
    {
      text: "缩放",
      items: [
        ...zoom,
        { item: "Separator" },
        item("zoom:0", "适应屏幕", !state.busy && !state.editing),
      ],
    },
    {
      text: "图像处理",
      enabled: !state.busy && !state.editing,
      items: [
        item("rotate-left", "向左旋转 90°"),
        item("rotate-right", "向右旋转 90°"),
        item("flip-x", "水平翻转"),
        item("flip-y", "垂直翻转"),
        { item: "Separator" },
        item("grayscale", "灰度"),
        item("invert", "反色"),
        item("reset-image", "还原图像"),
      ],
    },
    {
      text: "透明度",
      items: [1, 0.9, 0.75, 0.5, 0.25].map((value) => ({
        ...item(`opacity:${value}`, `${Math.round(value * 100)}%`),
        checked: state.opacity === value,
      })),
    },
    { item: "Separator" },
    item("paste", "粘贴", !state.busy && !state.editing),
    item("replace", "替换为文件…", !state.busy && !state.editing),
    { item: "Separator" },
    item("close", "关闭", true),
    item("destroy", "销毁", true),
    { item: "Separator" },
    {
      text: `${info.width} × ${info.height}`,
      items: [
        item("copy-size", "复制图像尺寸"),
        {
          ...item(
            "dimensions",
            `宽 ${info.width} 像素 · 高 ${info.height} 像素`,
          ),
          enabled: false,
        },
      ],
    },
  ];
}
