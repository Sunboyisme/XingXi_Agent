import { useCallback, useEffect, useRef, useState } from "react";
import { OnlineSpeechPlayer, type SpeechPhase } from "./onlineSpeech";
import { errorMessage } from "./utils";

type Reading = {
  id: number;
  selectionId: number;
  kind: "source" | "translation";
  phase: SpeechPhase;
};

export function useReadAloud(onError: (message: string) => void) {
  const [reading, setReading] = useState<Reading | null>(null);
  const current = useRef<Reading | null>(null);
  const player = useRef<OnlineSpeechPlayer | null>(null);
  if (!player.current) player.current = new OnlineSpeechPlayer();
  const mounted = useRef(false);
  const sequence = useRef(0);
  const error = useRef(onError);
  error.current = onError;
  const stop = useCallback(() => {
    current.current = null;
    player.current?.stop();
    if (mounted.current) setReading(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
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
    const next: Reading = {
      id: ++sequence.current,
      selectionId,
      kind,
      phase: "loading",
    };
    current.current = next;
    setReading(next);
    try {
      await player.current!.play(text, {
        onPhase: (phase) => {
          if (mounted.current && current.current?.id === next.id)
            setReading({ ...next, phase });
        },
      });
    } catch (cause) {
      if (mounted.current && current.current?.id === next.id)
        error.current(errorMessage(cause));
    } finally {
      if (mounted.current && current.current?.id === next.id) {
        current.current = null;
        setReading(null);
      }
    }
  }
  return { kind: reading?.kind, phase: reading?.phase, toggle, stop };
}
