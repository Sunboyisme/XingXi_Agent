// Business data stays read-only. Leave the requested dark theme selected for review.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const folder = resolve(".local-data/preview-runtime");
const shots = resolve(".local-data/real-preview-check");
mkdirSync(shots, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9290");
try {
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find(
      (p) =>
        p.url().startsWith("http://127.0.0.1:5190") &&
        !p.url().includes("view=reminder"),
    );
  assert.ok(page);
  page.setDefaultTimeout(15000);
  const connection = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("backend_config"),
  );
  assert.equal(
    connection.token,
    readFileSync(resolve(folder, "auth-token"), "utf8").trim(),
  );
  const get = async (path) => {
    const result = await fetch(connection.url + path, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.ok(result.ok, path);
    return result.json();
  };
  const before = {
    settings: await get("/settings"),
    plans: await get("/plans"),
    conversations: await get("/conversations"),
    data: await get("/settings/data"),
  };
  assert.ok(before.settings.model_configured);
  const selected = before.settings.providers.find(
    (p) => p.id === before.settings.default_provider,
  );
  assert.ok(selected.key_configured);
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "外观", exact: true }).click();
  await page.getByRole("radio", { name: "奶油杏 · 浅色", exact: true }).check();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "cream",
  );
  await page.screenshot({
    path: resolve(shots, "native-appearance-cream.png"),
  });
  await page.getByRole("radio", { name: "暖灰棕 · 深色", exact: true }).check();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".settings-tabs"))
        .backgroundColor === "rgb(59, 52, 45)",
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(
        document.querySelector('.settings-tabs [aria-selected="true"]'),
      ).backgroundColor === "rgb(45, 41, 37)",
  );
  await page.screenshot({ path: resolve(shots, "native-appearance-dark.png") });
  await page.getByRole("button", { name: "对话", exact: true }).click();
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).count())
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  const avatar = page.getByRole("button", {
    name: "点击头像新建对话",
    exact: true,
  });
  assert.ok(await avatar.locator(".bai-avatar").isVisible());
  let savedConversation = null;
  for (const conversation of before.conversations) {
    const messages = await get(`/conversations/${conversation.id}/messages`);
    if (messages.some((m) => m.role === "assistant")) {
      savedConversation = conversation;
      break;
    }
  }
  if (savedConversation) {
    await page
      .getByRole("button", { name: savedConversation.title, exact: true })
      .first()
      .click();
    await page.locator(".message.assistant").first().waitFor();
    assert.equal(await page.locator(".chat-main .bai-avatar").count(), 0);
    assert.equal(
      await page.locator(".message.assistant .message-avatar").count(),
      0,
    );
    await page.screenshot({
      path: resolve(shots, "native-dark-conversation.png"),
    });
  }
  await avatar.click();
  await page
    .getByRole("heading", { name: "今天想做点什么？", exact: true })
    .waitFor();
  assert.equal(await page.locator(".chat-main .bai-avatar").count(), 0);
  assert.ok(await avatar.locator(".bai-avatar").isVisible());
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  await page.screenshot({ path: resolve(shots, "native-dark-chat-home.png") });
  assert.deepEqual(await get("/settings"), before.settings);
  assert.deepEqual(await get("/plans"), before.plans);
  assert.deepEqual(await get("/conversations"), before.conversations);
  assert.deepEqual((await get("/settings/data")).counts, before.data.counts);
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
      theme: "warm-dark",
      original_light_theme: true,
      chat_character_removed: true,
      navigation_character_preserved: true,
      business_data_unchanged: true,
      saved_provider: selected.label,
      saved_model: selected.default_model,
      real_model_called: false,
      window: windowState,
    }),
  );
} finally {
  await browser.close(); // Keep the real desktop preview open.
}
