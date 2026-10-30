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

export type PinMenuSession = {
  requestId: string;
  owner: string;
  revision: number;
  width: number;
  height: number;
  scale: number;
  editing: boolean;
  busy: boolean;
  shadow: boolean;
  opacity: number;
  zoomOnly: boolean;
  anchorX: number;
  anchorY: number;
};
