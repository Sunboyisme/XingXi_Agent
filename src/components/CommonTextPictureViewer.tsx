import { useLayoutEffect, useRef, useState } from "react";
import type { CommonTextAsset } from "@/lib/commonTextDocument";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/** Use the full-resolution result, including saved annotations and masking. */
export function CommonTextPictureViewer({
  asset,
  url,
  onClose,
}: {
  asset: CommonTextAsset;
  url: string;
  onClose: () => void;
}) {
  const [originalSize, setOriginalSize] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    viewport.current?.scrollTo(0, 0);
  }, [originalSize]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="common-text-picture-viewer">
        <DialogHeader className="common-text-picture-viewer-heading">
          <DialogTitle>{asset.name}</DialogTitle>
          <DialogDescription className="sr-only">
            查看完整图片，可选择适应窗口或按原始尺寸查看。
          </DialogDescription>
          <div
            className="common-text-picture-viewer-toolbar"
            role="group"
            aria-label="图片显示尺寸"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={!originalSize}
              onClick={() => setOriginalSize(false)}
            >
              适应窗口
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={originalSize}
              onClick={() => setOriginalSize(true)}
            >
              原始尺寸 · 100%
            </Button>
            <span>
              {asset.width} × {asset.height}
            </span>
          </div>
        </DialogHeader>
        <div
          ref={viewport}
          className="common-text-picture-viewport"
          data-original-size={originalSize || undefined}
          tabIndex={0}
          role="region"
          aria-label="图片查看区域"
        >
          <div className="common-text-picture-canvas">
            <img
              src={url}
              alt={asset.name}
              width={asset.width}
              height={asset.height}
              draggable={false}
              style={
                originalSize
                  ? { width: asset.width, height: asset.height }
                  : undefined
              }
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
