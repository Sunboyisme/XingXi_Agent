// Read-only acceptance checks against the persistent real desktop preview.
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
    .filter(
      (p) =>
        p.url().startsWith("http://127.0.0.1:5190") &&
        !p.url().includes("view=reminder"),
    );
  assert.equal(pages.length, 1);
  const page = pages[0];
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
    assert.ok(response.ok);
    return response.json();
  };
  const before = await get("/plans");
  const settings = await get("/settings");
  assert.ok(settings.model_configured);
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.getByRole("button", { name: "日历", exact: true }).click();
  await page.getByRole("button", { name: "今天", exact: true }).click();
  await page.locator(".plan-month-grid").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "周历", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "月历", exact: true }).count(),
    0,
  );
  assert.equal(await page.locator(".holiday-source").count(), 0);
  await page.screenshot({
    path: resolve(shots, "native-calendar-month-only.png"),
  });
  const heading = page.locator(".plan-heading h1");
  for (let i = 0; i < 36; i++) {
    const [, y, m] = (await heading.textContent())
      .replace(/\s/g, "")
      .match(/(\d+)年(\d+)月/);
    const current = Number(y) * 12 + Number(m),
      target = 2027 * 12 + 2;
    if (current === target) break;
    await page
      .getByRole("button", {
        name: current < target ? "下一期" : "上一期",
        exact: true,
      })
      .click();
  }
  const eve = page.locator(
    '.plan-day:has([aria-label="2027-02-05 添加计划"]) .plan-lunar',
  );
  assert.equal(await eve.textContent(), "除夕");
  assert.match(await eve.getAttribute("title"), /腊月廿九.*除夕/);
  assert.equal(
    await page
      .locator('.plan-day:has([aria-label="2027-02-06 添加计划"]) .plan-lunar')
      .textContent(),
    "春节",
  );
  assert.equal(
    await page
      .locator('.plan-day:has([aria-label="2027-02-04 添加计划"]) .plan-lunar')
      .textContent(),
    "立春",
  );
  await page.screenshot({
    path: resolve(shots, "native-calendar-2027-eve.png"),
  });
  assert.deepEqual(await get("/plans"), before);
  assert.deepEqual(await get("/settings"), settings);
  assert.deepEqual(errors, []);
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
      profile: root,
      month_only: true,
      calendar_festivals: true,
      new_year_eve: "2027-02-05",
      real_plans_preserved: before.length,
      saved_model_configured: true,
      real_model_called: false,
      window: windowState,
      errors,
    }),
  );
} finally {
  await browser.close(); // Disconnect, keeping the real desktop app open.
}
