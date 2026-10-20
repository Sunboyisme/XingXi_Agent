import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(".local-data/preview-0.1.3");
const shots = resolve(".local-data/qa-0.1.3/screenshots");
mkdirSync(shots, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9290");
const pages = browser
  .contexts()
  .flatMap((context) => context.pages())
  .filter((page) => page.url().startsWith("http://127.0.0.1:5190"));
assert.equal(
  pages.length,
  1,
  "Only the isolated native preview may be targeted",
);
const page = pages[0];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(15000);
const connection = await page.evaluate(() =>
  window.__TAURI_INTERNALS__.invoke("backend_config"),
);
assert.equal(connection.url, "http://127.0.0.1:8790/api/v1");
assert.equal(
  connection.token,
  readFileSync(resolve(root, "auth-token"), "utf8").trim(),
);
const health = await fetch(connection.url + "/health").then((r) => r.json());
assert.equal(health.version, "0.1.3");
await page.reload();
await page
  .getByRole("button", { name: "点击头像新建对话", exact: true })
  .click();
if (
  await page.getByRole("button", { name: "展开侧栏", exact: true }).isVisible()
) {
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
}
await page
  .locator(".conversation-link > button:first-child")
  .filter({ hasText: "0.1.3 · 本地模拟图文" })
  .first()
  .click();
await page.locator(".answer-presentation img").waitFor();
assert.equal(
  await page
    .locator(".answer-presentation img")
    .evaluate((image) => image.naturalWidth),
  480,
);
assert.ok(
  await page.getByRole("link", { name: /示例网页（本地模拟）/ }).isVisible(),
);
await page.locator(".answer-sources").scrollIntoViewIfNeeded();
await page.screenshot({ path: resolve(shots, "native-image-sources.png") });
await page.locator(".answer-presentation .picture-trigger").click();
await page.getByRole("dialog").locator("img").waitFor();
await page.keyboard.press("Escape");
// Verify the native export route without launching or interacting with Explorer.
const presentation = await fetch(connection.url + "/conversations", {
  headers: { Authorization: `Bearer ${connection.token}` },
}).then((r) => r.json());
const conversation = presentation.find(
  (c) => c.title === "0.1.3 · 本地模拟图文",
);
const messages = await fetch(
  `${connection.url}/conversations/${conversation.id}/messages`,
  { headers: { Authorization: `Bearer ${connection.token}` } },
).then((r) => r.json());
const answer = messages.find((m) => m.role === "assistant");
const media = await fetch(
  `${connection.url}/runs/${answer.run_id}/presentation`,
  { headers: { Authorization: `Bearer ${connection.token}` } },
).then((r) => r.json());
const file = media.artifacts.find((a) => !a.image);
const exported = await fetch(`${connection.url}/artifacts/${file.id}/export`, {
  method: "POST",
  headers: { Authorization: `Bearer ${connection.token}` },
}).then((r) => r.json());
assert.ok(exported.path.startsWith(resolve(root, "exports")));
assert.ok(existsSync(exported.path));
await page.getByRole("button", { name: "连接与设置", exact: true }).click();
await page.getByRole("tab", { name: "技能", exact: true }).click();
await page.getByRole("button", { name: "查看技能", exact: true }).waitFor();
await page.screenshot({ path: resolve(shots, "native-skills.png") });
await page.getByRole("button", { name: "日序", exact: true }).click();
await page.getByRole("button", { name: "周历", exact: true }).click();
assert.equal(await page.locator(".plan-week-column").count(), 7);
await page.getByRole("button", { name: "月历", exact: true }).click();
const currentEvents = await fetch(connection.url + "/calendar/events", {
  headers: { Authorization: `Bearer ${connection.token}` },
}).then((r) => r.json());
if (currentEvents.some((e) => e.title === "本地原生验收：认识日序")) {
  await page
    .getByRole("button", { name: "本地原生验收：认识日序", exact: true })
    .first()
    .click();
} else {
  await page.getByRole("button", { name: "添加计划", exact: true }).click();
  await page.getByRole("menuitem", { name: /普通计划/ }).click();
}
await page
  .getByLabel("计划名称", { exact: true })
  .fill("本地原生验收：认识日序");
await page
  .getByLabel("备注", { exact: true })
  .fill(
    "本地原生窗口验收示例，未开启提醒，没有使用真实模型。可自行编辑或删除。",
  );
await page.getByRole("button", { name: "保存计划", exact: true }).click();
await page.getByRole("dialog").waitFor({ state: "hidden" });
await page
  .getByRole("button", { name: "本地原生验收：认识日序", exact: true })
  .first()
  .waitFor();
assert.ok(
  await page
    .locator(".calendar-page")
    .evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  "Month view should fit the native window",
);
await page.screenshot({ path: resolve(shots, "native-calendar.png") });
assert.deepEqual(errors, []);
console.log(
  "Native 0.1.3: isolated IPC/auth, CSP image rendering and zoom, persisted sources, file export, skills and calendar CRUD passed. No real model or WeChat acceptance.",
);
// Closing this client only disconnects CDP; the user-facing app must remain open.
await browser.close();
