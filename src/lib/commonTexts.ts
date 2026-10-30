import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { components } from "./api.generated";

export type CommonText = components["schemas"]["TextRead"];
export type TextCategory = components["schemas"]["CategoryRead"];
const event = "xiaoxi-common-texts-changed";
export function notifyCommonTextsChanged() {
  if (isTauri())
    void emit(event).catch(() => window.dispatchEvent(new Event(event)));
  else window.dispatchEvent(new Event(event));
}
export function useCommonTextsRevision() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const changed = () => {
      if (active) setRevision((value) => value + 1);
    };
    window.addEventListener(event, changed);
    const stop = isTauri() ? listen(event, changed) : undefined;
    return () => {
      active = false;
      window.removeEventListener(event, changed);
      void stop?.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  return revision;
}
