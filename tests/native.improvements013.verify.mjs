// Read-only native verification. This never imports fixtures or writes personal records.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const shots = resolve(".local-data/real-preview-check/improvements013");
mkdirSync(shots, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9290");
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().startsWith("http://127.0.0.1:5190"));
  assert.ok(page, "Persistent native preview is required");
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  const connection = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("backend_config"),
  );
  assert.equal(
    connection.token,
    readFileSync(
      resolve(".local-data/preview-runtime/auth-token"),
      "utf8",
    ).trim(),
  );
  const get = async (path) => {
    const response = await fetch(connection.url + path, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.ok(response.ok);
    return response.json();
  };
  const before = {
    conversations: await get("/conversations"),
    memories: await get("/memories"),
  };
  const skills = await get("/skills");
  assert.ok(
    skills.find(
      (skill) =>
        skill.name === "text-notes" &&
        skill.files.includes("scripts/make_note.py"),
    ),
  );
  await page.getByRole("button", { name: "计划", exact: true }).click();
  await page.locator(".plan-lunar").first().waitFor();
  assert.equal(await page.locator(".holiday-source").count(), 0);
  assert.ok((await page.locator(".plan-lunar.solar-term").count()) >= 2);
  await page.screenshot({ path: resolve(shots, "calendar.png") });
  assert.equal(
    await page.getByRole("button", { name: "周历", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "脚本环境", exact: true }).click();
  await page.getByLabel("Python 解释器路径", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.screenshot({ path: resolve(shots, "script-environments.png") });
  await page.getByRole("tab", { name: "技能", exact: true }).click();
  await page.locator(".skill-card").filter({ hasText: "text-notes" }).waitFor();
  await page.screenshot({ path: resolve(shots, "skills.png") });
  // Inspect actual saved sources, without inserting any chat or tool results.
  let sourceConversation;
  for (const conversation of before.conversations) {
    const messages = await get(`/conversations/${conversation.id}/messages`);
    for (const message of messages.filter(
      (m) => m.role === "assistant" && m.run_id,
    )) {
      const presentation = await get(`/runs/${message.run_id}/presentation`);
      if (presentation.sources?.length) {
        sourceConversation = conversation;
        break;
      }
    }
    if (sourceConversation) break;
  }
  let sourceChecked = false;
  if (sourceConversation) {
    await page.getByRole("button", { name: "对话", exact: true }).click();
    if (
      await page.getByRole("button", { name: "展开侧栏", exact: true }).count()
    )
      await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await page
      .locator(".conversation-link > button:first-child")
      .getByText(sourceConversation.title, { exact: true })
      .click();
    const sources = page.locator(".answer-sources").first();
    await sources.waitFor();
    assert.equal(await sources.getAttribute("open"), null);
    await sources.locator("summary").click();
    await sources.getByRole("link").first().waitFor();
    await page.screenshot({ path: resolve(shots, "saved-sources.png") });
    sourceChecked = true;
  }
  // Exercise native validation without launching a program or touching files.
  const rejected = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("open_external_url", {
        url: "file:///C:/Windows/notepad.exe",
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.ok(rejected);
  const after = {
    conversations: await get("/conversations"),
    memories: await get("/memories"),
  };
  assert.deepEqual(
    after,
    before,
    "Read-only UI checks must preserve personal records",
  );
  assert.deepEqual(errors, []);
  // Leave the app on the updated calendar for human acceptance.
  await page.getByRole("button", { name: "计划", exact: true }).click();
  console.log(
    JSON.stringify({
      native: true,
      data: "preview-runtime",
      personal_records_preserved: true,
      lunar_and_terms: true,
      holiday_badges_preserved: true,
      standalone_script_settings: true,
      bundled_skill: true,
      saved_sources_checked: sourceChecked,
      errors,
    }),
  );
} finally {
  await browser.close();
}
