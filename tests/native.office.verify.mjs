// Read-only against persistent real preview: never upload synthetic QA files or call a model.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const folder = resolve(".local-data/real-preview-check/office");
mkdirSync(folder, { recursive: true });
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
    readFileSync(
      resolve(".local-data/preview-runtime/auth-token"),
      "utf8",
    ).trim(),
  );
  const get = async (path) => {
    const r = await fetch(connection.url + path, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.ok(r.ok);
    return r.json();
  };
  const snapshot = () =>
    Promise.all([
      get("/settings"),
      get("/conversations"),
      get("/plans"),
      get("/settings/data"),
    ]);
  const before = await snapshot();
  assert.ok(before[0].model_configured);
  assert.ok(
    before[3].directory
      .replaceAll("\\", "/")
      .endsWith("/.local-data/preview-runtime"),
  );
  const tools = await get("/tools");
  for (const name of [
    "list_files",
    "read_file",
    "create_document",
    "create_spreadsheet",
    "create_text_file",
  ])
    assert.ok(tools.some((t) => t.id === name && t.available));
  const writes = [],
    errors = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/v1/"))
      writes.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).count())
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByLabel("添加文件或图片").waitFor();
  const accept = await page.getByLabel("添加文件或图片").getAttribute("accept");
  for (const ext of [".docx", ".pdf", ".xlsx", ".txt", ".md", ".csv", ".json"])
    assert.ok(accept.includes(ext));
  let artifact;
  for (const conversation of before[1].slice(0, 8)) {
    const messages = await get(`/conversations/${conversation.id}/messages`);
    for (const message of messages.filter(
      (m) => m.role === "assistant" && m.run_id,
    )) {
      const presentation = await get(`/runs/${message.run_id}/presentation`);
      const file = presentation.artifacts.find((a) => !a.image);
      if (file) {
        artifact = { ...file, conversation_id: conversation.id };
        break;
      }
    }
    if (artifact) break;
  }
  if (artifact) {
    if (
      await page.getByRole("button", { name: "展开侧栏", exact: true }).count()
    )
      await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    const index = before[1].findIndex((c) => c.id === artifact.conversation_id);
    await page
      .locator(".conversation-link > button:first-child")
      .nth(index)
      .click();
    await page
      .getByRole("button", { name: `预览 ${artifact.name}`, exact: true })
      .first()
      .waitFor();
    await page
      .getByRole("button", { name: `预览 ${artifact.name}`, exact: true })
      .first()
      .click();
    await page
      .getByRole("dialog")
      .locator(".office-preview-body pre")
      .first()
      .waitFor();
    await page.screenshot({
      path: resolve(folder, "existing-real-file-preview.png"),
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    writeFileSync(
      resolve(folder, "save-dialog-target.json"),
      JSON.stringify({ id: artifact.id, name: artifact.name }),
    );
  }
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: resolve(folder, "native-office-controls.png"),
  });
  const report = {
    provider_preserved: true,
    business_data_unchanged: true,
    tools: 5,
    formats: 7,
    existing_file_preview: Boolean(artifact),
    real_model_called: false,
    wechat_tested: false,
  };
  writeFileSync(
    resolve(folder, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
