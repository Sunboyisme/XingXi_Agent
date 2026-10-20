// Read-only native smoke check plus one real model connection request.
// Never seed or delete records in the user's persistent test profile.
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
  assert.equal(
    pages.length,
    1,
    "Only the persistent native test profile may be targeted",
  );
  const page = pages[0];
  page.setDefaultTimeout(15000);
  const connection = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("backend_config"),
  );
  assert.equal(
    connection.token,
    readFileSync(resolve(root, "auth-token"), "utf8").trim(),
  );
  const headers = { Authorization: `Bearer ${connection.token}` };
  const get = async (path) => {
    const response = await fetch(connection.url + path, { headers });
    assert.ok(response.ok, `Failed to read ${path}: ${response.status}`);
    return response.json();
  };
  const settings = await get("/settings");
  const selected = settings.providers.find(
    (p) => p.id === settings.default_provider,
  );
  assert.ok(
    selected?.key_configured && settings.model_configured,
    "A saved real model credential is required",
  );
  const host = new URL(selected.model_url).hostname;
  assert.ok(
    ![
      "localhost",
      "127.0.0.1",
      "::1",
      "example.com",
      "example.invalid",
    ].includes(host),
    "Mock model connections cannot pass native acceptance",
  );
  const before = await get("/conversations");
  const started = Date.now();
  // Use the actual native frontend's authenticated connection to the backend.
  const result = await page.evaluate(
    async ({ connection, selection }) => {
      const response = await fetch(connection.url + "/settings/test", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(selection),
      });
      return { status: response.status, body: await response.json() };
    },
    {
      connection,
      selection: {
        provider_id: selected.id,
        model_name: selected.default_model,
        thinking_enabled: false,
      },
    },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  const after = await get("/conversations");
  assert.deepEqual(
    after.map((c) => c.id).sort(),
    before.map((c) => c.id).sort(),
    "Connection checks must preserve conversations",
  );
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "连接", exact: true }).click();
  await page
    .locator(".model-connections")
    .filter({ hasText: selected.default_model })
    .waitFor();
  await page.screenshot({ path: resolve(shots, "native-real-model.png") });
  console.log(
    JSON.stringify({
      native_profile: root,
      provider: selected.label,
      model: selected.default_model,
      host,
      real_llm: result.body.message,
      elapsed_ms: Date.now() - started,
      conversations_preserved: after.length,
    }),
  );
} finally {
  // Disconnect only; keep the real desktop test app open for the user.
  await browser.close();
}
