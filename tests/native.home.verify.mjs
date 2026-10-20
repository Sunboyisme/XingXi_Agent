// Review actual preview data without submitting drafts, creating records or calling a model.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const folder = resolve(".local-data/preview-runtime");
const shots = resolve(".local-data/real-preview-check/chat-home");
mkdirSync(shots, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9290");
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find(
      (value) =>
        value.url().startsWith("http://127.0.0.1:5190") &&
        !value.url().includes("view=reminder"),
    );
  assert.ok(page);
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() =>
    ["cream", "warm-dark"].includes(document.documentElement.dataset.theme),
  );
  const connection = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("backend_config"),
  );
  assert.equal(
    connection.token,
    readFileSync(resolve(folder, "auth-token"), "utf8").trim(),
  );
  const get = async (path) => {
    const response = await fetch(connection.url + path, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.ok(response.ok, path);
    return response.json();
  };
  const before = await Promise.all([
    get("/settings"),
    get("/plans"),
    get("/conversations"),
    get("/settings/data"),
  ]);
  assert.ok(before[0].model_configured);
  const originalTheme = await page.locator("html").getAttribute("data-theme");
  const errors = [],
    writes = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/v1/"))
      writes.push(request.url().split("?")[0]);
  });
  await page
    .getByRole("button", { name: "点击头像新建对话", exact: true })
    .click();
  if (await page.getByRole("button", { name: "收起侧栏", exact: true }).count())
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  for (const theme of ["cream", "warm-dark"]) {
    await page.getByRole("button", { name: "连接与设置", exact: true }).click();
    await page.getByRole("tab", { name: "外观", exact: true }).click();
    await page
      .getByRole("radio", {
        name: theme === "cream" ? "奶油杏 · 浅色" : "暖灰棕 · 深色",
        exact: true,
      })
      .check();
    await page.getByRole("button", { name: "对话", exact: true }).click();
    await page.waitForFunction(
      (expected) =>
        getComputedStyle(document.querySelector(".main-panel"))
          .backgroundColor === expected,
      theme === "cream" ? "rgb(255, 252, 248)" : "rgb(45, 41, 37)",
    );
    assert.equal(await page.locator(".chat-main .bai-avatar").count(), 0);
    assert.equal(await page.locator(".chat-home [aria-pressed]").count(), 0);
    assert.equal(
      await page
        .getByRole("heading", { name: "今日安排", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page
        .getByRole("heading", { name: "上次任务", exact: true })
        .count(),
      1,
    );
    const bounds = await page.locator(".chat-home").boundingBox();
    const panel = await page.locator(".chat-main").boundingBox();
    assert.ok(
      bounds.y + bounds.height <= panel.y + panel.height,
      "Home fits in the desktop viewport",
    );
    await page.screenshot({
      path: resolve(shots, `native-${theme}.png`),
      animations: "disabled",
    });
    await page.locator(".chat-home").screenshot({
      path: resolve(shots, `detail-${theme}.png`),
      animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "外观", exact: true }).click();
  await page
    .getByRole("radio", {
      name: originalTheme === "warm-dark" ? "暖灰棕 · 深色" : "奶油杏 · 浅色",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  const after = await Promise.all([
    get("/settings"),
    get("/plans"),
    get("/conversations"),
    get("/settings/data"),
  ]);
  assert.deepEqual(after.slice(0, 3), before.slice(0, 3));
  assert.deepEqual(after[3].counts, before[3].counts);
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  const windowState = await page.evaluate(async () => ({
    visible: await window.__TAURI_INTERNALS__.invoke(
      "plugin:window|is_visible",
      { label: "main" },
    ),
    minimized: await window.__TAURI_INTERNALS__.invoke(
      "plugin:window|is_minimized",
      { label: "main" },
    ),
  }));
  assert.ok(windowState.visible && !windowState.minimized);
  console.log(
    JSON.stringify({
      profile: folder,
      layout: "single",
      themes: 2,
      theme_restored: originalTheme,
      business_data_unchanged: true,
      provider_preserved: true,
      real_model_called: false,
      window: windowState,
    }),
  );
} finally {
  await browser.close(); // Disconnect only; keep the desktop app open.
}
