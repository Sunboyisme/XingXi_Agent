import { useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Report actual visible controls, including portals, rather than guessing a transparent window's hit area. */
export function useDesktopHitRegions(selector: string) {
  useLayoutEffect(() => {
    const regionSelector = `${selector},.picture-overlay,.picture-viewer,.picture-close`;
    let disposed = false;
    let frame: number | undefined;
    const observed = new Set<Element>();
    const update = () => {
      if (disposed) return;
      const nodes = Array.from(document.querySelectorAll(regionSelector));
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
      if (frame !== undefined || disposed) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };
    const resize = new ResizeObserver(schedule);
    const mutation = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === "childList" ||
            (record.target instanceof Element &&
              (record.target.matches(regionSelector) ||
                record.target.querySelector(regionSelector))),
        )
      )
        schedule();
    });
    // Popper may reposition a portal without adding nodes or changing its size.
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "data-state"],
    });
    window.addEventListener("resize", schedule);
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    update();
    return () => {
      disposed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("animationend", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
    };
  }, [selector]);
}
