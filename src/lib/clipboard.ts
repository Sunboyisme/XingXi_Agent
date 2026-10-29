import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export async function copyText(text: string) {
  if (isTauri()) {
    await invoke("plugin:clipboard-manager|write_text", { text });
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const previous = document.activeElement as HTMLElement | null;
  const input = document.createElement("textarea");
  input.value = text;
  input.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(input);
  input.select();
  let success = false;
  try {
    success = document.execCommand("copy");
  } finally {
    input.remove();
    previous?.focus();
  }
  if (!success) throw new Error("copy failed");
}

/** 复制文本，并在短时间内保持“已复制”状态。 */
export function useCopyFeedback(text: string) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    setError("");
    try {
      await copyText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("复制失败，请选择文字后复制。");
    }
  }
  return { copied, error, copy };
}
