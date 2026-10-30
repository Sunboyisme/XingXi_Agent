import { useCallback, useEffect, useRef, useState } from "react";
import { desktopError, desktopListen, invoke } from "./desktopAssistant";

type Reading = {
  id: string;
  selectionId: number;
  kind: "source" | "translation";
};
type ReadingEvent = {
  id: string;
  selectionId: number;
  phase: string;
  error: string;
};

export function useReadAloud(onError: (message: string) => void) {
  const [reading, setReading] = useState<Reading | null>(null);
  const current = useRef<Reading | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const ready = useRef<Promise<unknown>>(Promise.resolve());
  const error = useRef(onError);
  error.current = onError;
  const stop = useCallback(() => {
    const own = ++revision.current;
    const old = current.current;
    current.current = null;
    if (mounted.current) setReading(null);
    if (old)
      void invoke("read_aloud_stop", { id: old.id }).catch((cause) => {
        if (mounted.current && own === revision.current && !current.current)
          error.current(`停止朗读未完成：${desktopError(cause)}`);
      });
  }, []);
  useEffect(() => {
    mounted.current = true;
    const listener = desktopListen<ReadingEvent>(
      "selection-reading",
      (event) => {
        if (
          !mounted.current ||
          event.id !== current.current?.id ||
          event.selectionId !== current.current.selectionId
        )
          return;
        if (["finished", "error"].includes(event.phase)) {
          current.current = null;
          setReading(null);
          if (event.error) error.current(event.error);
        }
      },
    );
    ready.current = listener;
    void listener.catch(() => {});
    return () => {
      mounted.current = false;
      stop();
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [stop]);
  async function toggle(
    text: string,
    kind: Reading["kind"],
    selectionId: number,
  ) {
    if (
      current.current?.kind === kind &&
      current.current.selectionId === selectionId
    ) {
      stop();
      return;
    }
    stop();
    ++revision.current;
    const next = { id: crypto.randomUUID(), selectionId, kind };
    current.current = next;
    setReading(next);
    try {
      await ready.current;
      if (!mounted.current || current.current?.id !== next.id) return;
      await invoke("read_aloud_start", { selectionId, id: next.id, text });
    } catch (cause) {
      if (mounted.current && current.current?.id === next.id) {
        current.current = null;
        setReading(null);
        error.current(desktopError(cause));
      }
    }
  }
  return { kind: reading?.kind, toggle, stop };
}
