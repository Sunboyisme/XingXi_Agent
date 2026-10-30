import { test, expect } from "@playwright/test";

// Browser layout regression only. Native selection, clipboard and window placement
// are separate checks; this stub never opens or writes the real preview runtime.
test("selection feedback keeps the close control on its row and then dismisses", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const surface = window as any;
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; callback: number }>();
    surface.isTauri = true;
    surface.__selectionClosed = false;
    surface.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "selection" },
        currentWebview: { label: "selection" },
      },
      transformCallback(callback: (value: unknown) => void) {
        const id = ++sequence;
        callbacks.set(id, callback);
        return id;
      },
      async invoke(command: string, args: any = {}) {
        if (command === "plugin:event|listen") {
          const id = ++sequence;
          listeners.set(id, { event: args.event, callback: args.handler });
          return id;
        }
        if (command === "backend_config") return { url: "/api/v1", token: "" };
        if (command === "selection_snapshot")
          return { id: 2, text: "复制反馈布局检查", error: "", x: 30, y: 30 };
        if (command === "plugin:clipboard-manager|write_text") {
          surface.__selectionCopied = args.text;
          return;
        }
        if (command === "selection_dismiss") {
          surface.__selectionClosed = true;
          for (const listener of listeners.values())
            if (listener.event === "selection-hidden")
              callbacks.get(listener.callback)?.({ payload: args.id });
        }
      },
    };
    surface.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event: string, id: number) {
        listeners.delete(id);
      },
    };
  });
  await page.setViewportSize({ width: 635, height: 220 });
  await page.goto("/?view=selection");
  const copy = page.getByRole("button", { name: "复制", exact: true });
  const close = page.getByRole("button", { name: "关闭划词助手", exact: true });
  await expect(copy).toBeVisible();
  await expect(page.getByRole("button", { name: "问 AI" })).toHaveCount(0);
  const before = await close.boundingBox();
  await copy.click();
  await expect(page.getByRole("status")).toHaveText("已复制选中文字");
  const after = await close.boundingBox();
  expect(after!.y).toBe(before!.y);
  expect(after!.x).toBe(before!.x);
  await expect(copy).toHaveText("复制");
  await expect
    .poll(() => page.evaluate(() => (window as any).__selectionClosed))
    .toBe(true);
  await expect(page.getByRole("main", { name: "划词助手" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__selectionCopied)).toBe(
    "复制反馈布局检查",
  );
  await page.setViewportSize({ width: 340, height: 240 });
  await page.reload();
  await expect(close).toBeVisible();
  const toolbar = await page.locator(".selection-toolbar").boundingBox();
  const narrowClose = await close.boundingBox();
  expect(narrowClose!.y - toolbar!.y).toBeLessThan(4);
  expect(narrowClose!.x + narrowClose!.width).toBeLessThanOrEqual(340);
});
