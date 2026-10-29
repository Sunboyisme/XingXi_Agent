import { useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Report actual visible controls, including portals, rather than guessing a transparent window's hit area. */
export function useDesktopHitRegions(selector: string) {
  useLayoutEffect(() => {
    let disposed = false;
    let queued = false;
    const observed = new Set<Element>();
    const update = () => {
      if (disposed) return;
      const nodes = Array.from(
        document.querySelectorAll(
          `${selector},.picture-overlay,.picture-viewer,.picture-close`,
        ),
      );
      for (const node of observed)
        if (!nodes.includes(node)) {
          resize.unobserve(node);
          observed.delete(node);
        }
      for (const node of nodes)
        if (!observed.has(node)) {
          resize.observe(node);
          observed.add(node);
        }
      const regions = nodes
        .map((node) => node.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .slice(0, 32)
        .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
      void invoke("desktop_hit_regions", { regions }).catch(() => {});
    };
    const schedule = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        update();
      });
    };
    const resize = new ResizeObserver(schedule);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    update();
    return () => {
      disposed = true;
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("animationend", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
    };
  }, [selector]);
}
