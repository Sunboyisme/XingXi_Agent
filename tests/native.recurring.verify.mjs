// Real profile, read-only UI checks. Never seed or save example plans here.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const folder = resolve(".local-data/preview-runtime");
const shots = resolve(".local-data/real-preview-check/recurring-plans");
mkdirSync(shots, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9290");
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find(
      (page) =>
        page.url().startsWith("http://127.0.0.1:5190") &&
        !page.url().includes("view=reminder"),
    );
  assert.ok(page);
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() =>
    ["cream", "warm-dark"].includes(document.documentElement.dataset.theme),
  );
  const config = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("backend_config"),
  );
  assert.equal(
    config.token,
    readFileSync(resolve(folder, "auth-token"), "utf8").trim(),
  );
  const get = async (path) => {
    const response = await fetch(config.url + path, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    assert.ok(response.ok, path);
    return response.json();
  };
  const before = await Promise.all([
    get("/settings"),
    get("/plans"),
    get("/settings/data"),
  ]);
  assert.equal(resolve(before[2].directory), folder);
  assert.ok(before[0].model_configured);
  assert.ok(
    before[0].providers.find(
      (provider) => provider.id === before[0].default_provider,
    ).key_configured,
  );
  const originalTheme = await page.locator("html").getAttribute("data-theme");
  const errors = [],
    writes = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/v1/"))
      writes.push(request.url());
  });
  async function theme(value) {
    await page.getByRole("button", { name: "连接与设置", exact: true }).click();
    await page.getByRole("tab", { name: "外观", exact: true }).click();
    await page
      .getByRole("radio", {
        name: value === "cream" ? "奶油杏 · 浅色" : "暖灰棕 · 深色",
        exact: true,
      })
      .check();
  }
  async function march() {
    await page.getByRole("button", { name: "计划", exact: true }).click();
    for (let index = 0; index < 18; index++) {
      const text = await page.locator(".plan-heading h1").innerText();
      const match = text.match(/(\d+)\s*年\s*(\d+)\s*月/);
      assert.ok(match, text);
      const month = Number(match[1]) * 12 + Number(match[2]);
      if (month === 2027 * 12 + 3) break;
      await page
        .getByRole("button", {
          name: month < 2027 * 12 + 3 ? "下一期" : "上一期",
          exact: true,
        })
        .click();
    }
  }
  for (const color of ["cream", "warm-dark"]) {
    await theme(color);
    await march();
    for (const plan of before[1].filter(
      (plan) =>
        plan.recurrence !== "none" && plan.calendar_display !== "always",
    ))
      assert.equal(
        await page
          .locator(".plan-month-grid .day-event")
          .filter({ hasText: plan.title })
          .count(),
        0,
      );
    await page.screenshot({
      path: resolve(shots, `native-${color}-month.png`),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "周历", exact: true }).click();
    await page.locator(".plan-week-grid").waitFor();
    await page.screenshot({
      path: resolve(shots, `native-${color}-week.png`),
      animations: "disabled",
    });
    await page.locator(".week-event").first().click();
    await page.getByRole("dialog").waitFor();
    assert.ok(
      (await page.getByRole("dialog").locator(".plan-agenda-row").count()) > 0,
    );
    await page.screenshot({
      path: resolve(shots, `native-${color}-day.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.locator(".week-event").first().click();
    await page.getByRole("button", { name: /^编辑 / }).click();
    assert.equal(await page.getByLabel("修改范围", { exact: true }).count(), 0);
    assert.equal(await page.getByLabel("月历显示", { exact: true }).count(), 0);
    await page.screenshot({
      path: resolve(shots, `native-${color}-whole-series.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
  }
  await theme(originalTheme);
  await march();
  const after = await Promise.all([
    get("/settings"),
    get("/plans"),
    get("/settings/data"),
  ]);
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
  assert.deepEqual(after[2].counts, before[2].counts);
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  const state = await page.evaluate(async () => ({
    visible: await window.__TAURI_INTERNALS__.invoke(
      "plugin:window|is_visible",
      { label: "main" },
    ),
    minimized: await window.__TAURI_INTERNALS__.invoke(
      "plugin:window|is_minimized",
      { label: "main" },
    ),
  }));
  assert.ok(state.visible && !state.minimized);
  const report = {
    profile: folder,
    month: "2027-03",
    themes: 2,
    daily_repeats_in_week_view: true,
    one_row_per_series: true,
    whole_series_edit: true,
    real_model_called: false,
    business_data_unchanged: true,
    connection_preserved: true,
    window: state,
  };
  writeFileSync(
    resolve(shots, "native-verification.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
