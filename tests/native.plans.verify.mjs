// Read-only checks against the real, persistent Tauri preview. Never seed records.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".local-data/preview-runtime");
const shots = resolve(".local-data/real-preview-check");
mkdirSync(shots, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9290");
try {
  const pages = browser
    .contexts()
    .flatMap((c) => c.pages())
    .filter((p) => p.url().startsWith("http://127.0.0.1:5190"));
  assert.equal(pages.length, 1);
  const page = pages[0];
  page.setDefaultTimeout(15000);
  const connection = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("backend_config"),
  );
  assert.equal(
    connection.token,
    readFileSync(resolve(root, "auth-token"), "utf8").trim(),
  );
  const get = async (path) => {
    const response = await fetch(connection.url + path, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  const before = await get("/plans");
  const settings = await get("/settings");
  assert.ok(settings.model_configured);
  const provider = settings.providers.find(
    (p) => p.id === settings.default_provider,
  );
  assert.ok(provider.key_configured);
  await page.getByRole("button", { name: "计划", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "提醒", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "日历计划", exact: true }).count(),
    0,
  );
  await page.locator(".plan-month-grid").waitFor();
  await page.screenshot({ path: resolve(shots, "native-plans-calendar.png") });
  await page.getByRole("button", { name: "周历", exact: true }).click();
  await page.locator(".plan-week-grid").waitFor();
  await page.screenshot({ path: resolve(shots, "native-plans-week.png") });
  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await page.getByRole("menuitem", { name: /重复日程/ }).click();
  assert.equal(
    await page.getByLabel("指定时间", { exact: true }).isChecked(),
    false,
  );
  await page.getByRole("button", { name: "开始", exact: true }).click();
  await page.locator(".datetime-popover").waitFor();
  assert.equal(
    await page.locator(".datetime-popover .calendar-time").count(),
    0,
  );
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await page.getByLabel("设置提醒时间", { exact: true }).check();
  await page.getByRole("button", { name: "添加提醒时间", exact: true }).click();
  await page.getByRole("button", { name: "提醒时间 2", exact: true }).waitFor();
  await page.getByRole("combobox", { name: "重复频率", exact: true }).click();
  await page.getByRole("option", { name: "每周", exact: true }).click();
  await page.getByLabel("间隔（周）", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "查看通知", exact: true }).click();
  await page.getByRole("dialog").filter({ hasText: "知道了" }).waitFor();
  await page.screenshot({
    path: resolve(shots, "native-plan-notifications.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "日历", exact: true }).click();
  assert.deepEqual(
    await get("/plans"),
    before,
    "Native UI verification must not create or change real plans",
  );
  console.log(
    JSON.stringify({
      native_profile: root,
      canonical_plans: before.length,
      provider: provider.label,
      model: provider.default_model,
      read_only_native_checks: "passed",
      screenshots: shots,
    }),
  );
} finally {
  await browser.close(); // Disconnect, leaving the desktop preview open.
}
