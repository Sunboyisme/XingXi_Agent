import { useEffect, useRef, useState, type PointerEvent } from "react";
import { api, fetchApi } from "@/lib/api";
import {
  paintCaptureMark,
  type CaptureMark,
  type CapturePoint,
  type CaptureTool,
} from "@/lib/captureDrawing";
import { captureMarkBounds, constrainedCapturePoint } from "@/lib/captureScene";
import {
  canvasBlob,
  uploadCommonTextImage,
  type CommonTextAsset,
} from "@/lib/commonTextDocument";
import { errorMessage } from "@/lib/utils";
import { CaptureObjects } from "./CaptureObjects";
import { ConfirmDelete, ErrorNotice } from "./common";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";

const tools = [
  ["select", "选择标注"],
  ["pen", "画笔"],
  ["line", "直线"],
  ["arrow", "箭头"],
  ["rect", "矩形"],
  ["ellipse", "椭圆"],
  ["text", "文字"],
  ["mosaic", "马赛克"],
  ["erase", "框选删除"],
] as const;

export function CommonTextImageEditor({
  assetId,
  onClose,
  onSaved,
}: {
  assetId: string;
  onClose: () => void;
  onSaved: (asset: CommonTextAsset) => void;
}) {
  const [asset, setAsset] = useState<CommonTextAsset>();
  const [source, setSource] = useState<HTMLCanvasElement>();
  const [marks, setMarks] = useState<CaptureMark[]>([]);
  const [history, setHistory] = useState<CaptureMark[][]>([]);
  const [redo, setRedo] = useState<CaptureMark[][]>([]);
  const [live, setLive] = useState<CaptureMark | null>(null);
  const [tool, setTool] = useState<CaptureTool | "select">("select");
  const [selected, setSelected] = useState<number | null>(null);
  const [color, setColor] = useState("#ef4444");
  const [width, setWidth] = useState(3);
  const [fontSize, setFontSize] = useState(24);
  const [text, setText] = useState<{
    at: CapturePoint;
    value: string;
    index?: number;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const [retry, setRetry] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null),
    stage = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    pointer: number;
    start: CapturePoint;
    mark: CaptureMark;
  } | null>(null);
  const sourceBlob = useRef<Blob | undefined>(undefined);
  const lock = useRef(false),
    mounted = useRef(false);
  function cancelDrawing() {
    const active = gesture.current;
    gesture.current = null;
    if (active && canvas.current?.hasPointerCapture(active.pointer))
      canvas.current.releasePointerCapture(active.pointer);
    setLive(null);
  }
  useEffect(() => {
    window.addEventListener("blur", cancelDrawing);
    return () => {
      window.removeEventListener("blur", cancelDrawing);
      cancelDrawing();
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setError("");
    void Promise.all([
      api<CommonTextAsset>(`/common-text-assets/${assetId}`, "GET", undefined, {
        signal: controller.signal,
      }),
      fetchApi(`/common-text-assets/${assetId}/original`, {
        signal: controller.signal,
      }).then((response) => response.blob()),
    ])
      .then(async ([meta, blob]) => {
        const bitmap = await createImageBitmap(blob);
        if (controller.signal.aborted) {
          bitmap.close();
          return;
        }
        const original = document.createElement("canvas");
        original.width = bitmap.width;
        original.height = bitmap.height;
        original.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close();
        sourceBlob.current = blob;
        setSource(original);
        setAsset(meta);
        setMarks(meta.scene?.marks || []);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [assetId, retry]);
  useEffect(() => {
    if (!source || !canvas.current) return;
    const context = canvas.current.getContext("2d")!;
    context.clearRect(0, 0, source.width, source.height);
    context.drawImage(source, 0, 0);
    marks.forEach((mark) => paintCaptureMark(context, mark, source));
    if (live && live.tool !== "erase") paintCaptureMark(context, live, source);
    if (live?.tool === "erase") {
      const b = captureMarkBounds(live);
      context.save();
      context.strokeStyle = "#9c5538";
      context.lineWidth = 2;
      context.strokeRect(b.x, b.y, b.w, b.h);
      context.restore();
    }
  }, [source, marks, live]);
  function commit(before: CaptureMark[], next: CaptureMark[]) {
    setHistory((h) => [...h.slice(-99), before]);
    setRedo([]);
    setMarks(next);
  }
  function undo() {
    if (busy || text || gesture.current || !history.length) return;
    setRedo((r) => [...r, marks]);
    setMarks(history.at(-1)!);
    setHistory((h) => h.slice(0, -1));
    setSelected(null);
  }
  function redoAction() {
    if (busy || text || gesture.current || !redo.length) return;
    setHistory((h) => [...h, marks]);
    setMarks(redo.at(-1)!);
    setRedo((r) => r.slice(0, -1));
    setSelected(null);
  }
  function point(event: PointerEvent): CapturePoint {
    const bounds = stage.current!.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          source!.width,
          ((event.clientX - bounds.left) * source!.width) / bounds.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          source!.height,
          ((event.clientY - bounds.top) * source!.height) / bounds.height,
        ),
      ),
    };
  }
  function applyStyle(update: Partial<CaptureMark>) {
    if (selected !== null && marks[selected])
      commit(
        marks,
        marks.map((mark, index) =>
          index === selected ? { ...mark, ...update } : mark,
        ),
      );
  }
  function applyText() {
    if (!text?.value.trim()) return;
    const mark: CaptureMark = {
      tool: "text",
      points: [text.at],
      text: text.value,
      color,
      width,
      size: fontSize,
    };
    commit(
      marks,
      text.index === undefined
        ? [...marks, mark]
        : marks.map((value, index) => (index === text.index ? mark : value)),
    );
    setText(undefined);
  }
  function close() {
    if (lock.current) return;
    if (
      text ||
      JSON.stringify(marks) !== JSON.stringify(asset?.scene?.marks || [])
    )
      setDiscard(true);
    else onClose();
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent
          className="common-text-image-editor"
          showCloseButton={!busy}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLowerCase() === "z" &&
              !(event.target instanceof HTMLTextAreaElement)
            ) {
              event.preventDefault();
              event.stopPropagation();
              event.shiftKey ? redoAction() : undo();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>编辑图片标注</DialogTitle>
            <DialogDescription>
              {asset?.name || "正在读取图片…"}
            </DialogDescription>
          </DialogHeader>
          {source && (
            <>
              <fieldset disabled={busy} className="common-image-controls">
                <div
                  className="common-image-tools"
                  role="group"
                  aria-label="标注工具"
                >
                  {tools.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={tool === id}
                      onClick={() => {
                        setTool(id);
                        setSelected(null);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label>
                  颜色{" "}
                  <input
                    type="color"
                    aria-label="标注颜色"
                    value={color}
                    onChange={(event) => {
                      setColor(event.target.value);
                      applyStyle({ color: event.target.value });
                    }}
                  />
                </label>
                <label>
                  线宽{" "}
                  <select
                    value={width}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setWidth(value);
                      applyStyle({ width: value });
                    }}
                  >
                    {[2, 3, 5, 8].map((n) => (
                      <option key={n} value={n}>
                        {n} px
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  字号{" "}
                  <select
                    value={fontSize}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setFontSize(value);
                      applyStyle({ size: value });
                    }}
                  >
                    {[16, 20, 24, 32, 48].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={Boolean(text) || !history.length}
                  onClick={undo}
                >
                  撤销
                </button>
                <button
                  type="button"
                  disabled={Boolean(text) || !redo.length}
                  onClick={redoAction}
                >
                  重做
                </button>
                {selected !== null && (
                  <button
                    type="button"
                    data-delete-action
                    disabled={Boolean(text)}
                    onClick={() => {
                      commit(
                        marks,
                        marks.filter((_, index) => index !== selected),
                      );
                      setSelected(null);
                    }}
                  >
                    删除标注
                  </button>
                )}
              </fieldset>
              <div
                className="common-image-stage"
                ref={stage}
                style={{
                  aspectRatio: `${source.width} / ${source.height}`,
                  width: `min(100%, ${(54 * source.width) / source.height}vh, 760px)`,
                }}
              >
                <canvas
                  ref={canvas}
                  width={source.width}
                  height={source.height}
                  onPointerDown={(event) => {
                    if (busy || text || event.button !== 0) return;
                    const at = point(event);
                    event.preventDefault();
                    if (tool === "select") {
                      setSelected(null);
                      return;
                    }
                    if (tool === "text") {
                      setText({ at, value: "" });
                      return;
                    }
                    gesture.current = {
                      pointer: event.pointerId,
                      start: at,
                      mark: {
                        tool,
                        points: [at, at],
                        color,
                        width,
                        size: fontSize,
                      },
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const g = gesture.current;
                    if (!g || g.pointer !== event.pointerId) return;
                    const at = constrainedCapturePoint(
                      g.start,
                      point(event),
                      g.mark.tool,
                      event.shiftKey,
                    );
                    g.mark = {
                      ...g.mark,
                      points:
                        g.mark.tool === "pen"
                          ? [...g.mark.points, at]
                          : [g.start, at],
                    };
                    setLive(g.mark);
                  }}
                  onPointerUp={(event) => {
                    const g = gesture.current;
                    if (!g || g.pointer !== event.pointerId) return;
                    gesture.current = null;
                    if (g.mark.tool === "erase") {
                      const b = captureMarkBounds(g.mark),
                        context = source.getContext("2d")!;
                      commit(
                        marks,
                        marks.filter((mark) => {
                          const r = captureMarkBounds(mark, context);
                          return (
                            r.x > b.x + b.w ||
                            r.x + r.w < b.x ||
                            r.y > b.y + b.h ||
                            r.y + r.h < b.y
                          );
                        }),
                      );
                    } else commit(marks, [...marks, g.mark]);
                    setLive(null);
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onPointerCancel={cancelDrawing}
                  onLostPointerCapture={cancelDrawing}
                />
                {tool === "select" && !busy && !text && (
                  <CaptureObjects
                    marks={marks}
                    selected={selected}
                    onSelect={(index) => {
                      setSelected(index);
                      if (index !== null) {
                        setColor(marks[index].color);
                        setWidth(marks[index].width);
                        setFontSize(marks[index].size);
                      }
                    }}
                    onPreview={setMarks}
                    onCommit={commit}
                    point={point}
                    context={source.getContext("2d")!}
                    styleRect={(b) => ({
                      left: `${(b.x / source.width) * 100}%`,
                      top: `${(b.y / source.height) * 100}%`,
                      width: `${(b.w / source.width) * 100}%`,
                      height: `${(b.h / source.height) * 100}%`,
                    })}
                    onEditText={(index) => {
                      const mark = marks[index];
                      setText({
                        at: mark.points[0],
                        value: mark.text || "",
                        index,
                      });
                    }}
                  />
                )}
              </div>
              {text && (
                <div className="common-image-text-entry">
                  <Textarea
                    autoFocus
                    aria-label="文字标注内容"
                    value={text.value}
                    disabled={busy}
                    onChange={(event) =>
                      setText({ ...text, value: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    disabled={busy || !text.value.trim()}
                    onClick={applyText}
                  >
                    应用文字
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setText(undefined)}
                  >
                    取消文字
                  </Button>
                </div>
              )}
            </>
          )}
          {error && (
            <ErrorNotice
              message={error}
              retry={!source ? () => setRetry((n) => n + 1) : undefined}
            />
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={close}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={busy || !source || Boolean(text)}
              onClick={async () => {
                if (
                  lock.current ||
                  gesture.current ||
                  !source ||
                  !sourceBlob.current ||
                  !asset
                )
                  return;
                lock.current = true;
                setBusy(true);
                setError("");
                try {
                  const result = document.createElement("canvas");
                  result.width = source.width;
                  result.height = source.height;
                  const context = result.getContext("2d")!;
                  context.drawImage(source, 0, 0);
                  marks.forEach((mark) =>
                    paintCaptureMark(context, mark, source),
                  );
                  const saved = await uploadCommonTextImage(
                    new File([sourceBlob.current], asset.name, {
                      type: "image/png",
                    }),
                    await canvasBlob(result),
                    {
                      version: 1,
                      width: source.width,
                      height: source.height,
                      marks,
                    },
                  );
                  if (mounted.current) onSaved(saved);
                  else
                    void api(`/common-text-assets/${saved.id}`, "DELETE").catch(
                      () => {},
                    );
                } catch (cause) {
                  if (mounted.current) setError(errorMessage(cause));
                } finally {
                  lock.current = false;
                  if (mounted.current) setBusy(false);
                }
              }}
            >
              {busy ? "保存中…" : "应用修改"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        open={discard}
        title="放弃图片修改？"
        description="尚未应用的标注修改将不会保存。"
        label="放弃修改"
        onClose={() => setDiscard(false)}
        onConfirm={async () => onClose()}
      />
    </>
  );
}
