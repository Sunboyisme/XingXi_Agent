import { useEffect, useRef, type RefObject } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { errorMessage } from "./utils";

type NativeFile = { path: string; name: string; directory: boolean; relative_path: string; bytes: number[]; last_modified?: number };
type Target = { element: () => HTMLElement | null; enabled: () => boolean; recursive: boolean; foldersOnly: boolean; receive: (files: NativeFile[]) => void | Promise<void>; error: (text: string) => void; loading: (value: boolean) => void };
const targets = new Set<Target>();
const receiving = new WeakSet<Target>();
let listening: Promise<void> | undefined;

function listen() {
  if (!isTauri()) return;
  listening ??= getCurrentWebview().onDragDropEvent(async ({ payload }) => {
    for (const target of targets) target.element()?.classList.remove("image-drag-over");
    if (payload.type === "leave") return;
    const x = payload.position.x / window.devicePixelRatio;
    const y = payload.position.y / window.devicePixelRatio;
    const target = [...targets].filter((item) => {
      const element = item.element();
      if (!element || !item.enabled()) return false;
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(x, y);
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
        && Boolean(hit && element.contains(hit));
    }).sort((a, b) => (a.element()!.getBoundingClientRect().width * a.element()!.getBoundingClientRect().height) - (b.element()!.getBoundingClientRect().width * b.element()!.getBoundingClientRect().height))[0];
    if (!target) return;
    if (payload.type !== "drop") { target.element()?.classList.add("image-drag-over"); return; }
    if (receiving.has(target)) { target.error(target.foldersOnly ? "正在处理上次拖入的文件夹，请稍候" : "正在读取上次拖入的文件，请稍候"); return; }
    const element = target.element();
    receiving.add(target);
    target.loading(true);
    try {
      if (target.foldersOnly && payload.paths.length > 20) throw new Error("每次最多拖入 20 个文件夹");
      if (!target.foldersOnly && !target.recursive && payload.paths.length > 4) throw new Error("每次最多提交 4 个附件");
      const files = await invoke<NativeFile[]>("read_dropped_files", { paths: payload.paths, recursive: target.recursive, foldersOnly: target.foldersOnly });
      // Native reading can outlive a navigation or opening a modal. Never hand
      // an old drop to the callbacks of a different conversation or screen.
      if (!targets.has(target) || !target.enabled() || target.element() !== element) return;
      await target.receive(files);
    } catch (error) {
      if (targets.has(target) && target.enabled() && target.element() === element) target.error(errorMessage(error));
    } finally {
      receiving.delete(target);
      if (targets.has(target) && target.element() === element) target.loading(false);
    }
  }).then(() => undefined).catch(() => { listening = undefined; });
}

export function nativeFile(file: NativeFile): File {
  return Object.assign(new File([new Uint8Array(file.bytes)], file.name, { lastModified: file.last_modified || 0 }), { nativePath: file.path });
}

export function useNativeDrop(ref: RefObject<HTMLElement | null>, receive: Target["receive"], error: Target["error"], recursive = false, disabled = false, scopeKey = "default", onReading?: Target["loading"], foldersOnly = false) {
  const callbacks = useRef({ receive, error, disabled, scopeKey, onReading });
  callbacks.current = { receive, error, disabled, scopeKey, onReading };
  useEffect(() => {
    if (!isTauri()) return;
    const target: Target = { element: () => ref.current, enabled: () => !callbacks.current.disabled && callbacks.current.scopeKey === scopeKey, recursive, foldersOnly,
      receive: (files) => callbacks.current.receive(files), error: (message) => callbacks.current.error(message),
      loading: (value) => { if (callbacks.current.scopeKey === scopeKey) callbacks.current.onReading?.(value); } };
    targets.add(target); listen();
    return () => { targets.delete(target); ref.current?.classList.remove("image-drag-over"); };
  }, [ref, recursive, scopeKey, foldersOnly]);
}
