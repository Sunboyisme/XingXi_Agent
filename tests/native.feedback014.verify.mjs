// Read-only UI verification on the persistent preview; never submit model or plan requests.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(".local-data/real-preview-check/feedback014");
mkdirSync(output, { recursive: true });
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
    const response = await fetch(connection.url + path, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.ok(response.ok, path);
    return response.json();
  };
  const snapshot = () =>
    Promise.all([
      get("/settings"),
      get("/plans"),
      get("/skills"),
      get("/conversations"),
      get("/settings/data"),
    ]);
  const before = await snapshot();
  assert.ok(before[0].model_configured);
  assert.ok(
    before[4].directory
      .replaceAll("\\", "/")
      .endsWith("/.local-data/preview-runtime"),
  );
  const writes = [],
    errors = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/v1/"))
      writes.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "技能", exact: true }).click();
  await page.locator(".skill-menu .toolbox-row-copy small").first().waitFor();
  const descriptions = await page
    .locator(".skill-menu .toolbox-row-copy small")
    .evaluateAll((items) =>
      items.map((e) => ({
        clamp: getComputedStyle(e).webkitLineClamp,
        height: e.getBoundingClientRect().height,
        line: Number.parseFloat(getComputedStyle(e).lineHeight),
      })),
    );
  assert.ok(descriptions.length);
  assert.ok(
    descriptions.every((d) => d.clamp === "2" && d.height <= d.line * 2 + 1),
  );
  await page.screenshot({ path: resolve(output, "skills-menu.png") });
  await page.getByRole("menuitem", { name: "管理技能", exact: true }).click();
  await page
    .getByRole("button", { name: "查看技能", exact: true })
    .first()
    .click();
  const summary = page
    .locator(".skill-detail-dialog .skill-disclosure > summary")
    .first();
  await summary.waitFor();
  const padding = await summary.evaluate((e) => ({
    left: parseFloat(getComputedStyle(e).paddingLeft),
    right: parseFloat(getComputedStyle(e).paddingRight),
  }));
  assert.ok(padding.left >= 12 && padding.right >= 12);
  await summary.click();
  await page.screenshot({ path: resolve(output, "skill-detail.png") });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "MCP 工具", exact: true }).click();
  await page.getByRole("menuitem", { name: "配置 MCP", exact: true }).click();
  await page.getByRole("button", { name: "添加 MCP", exact: true }).click();
  assert.equal(
    await page.locator(".mcp-header-hint").textContent(),
    "请按服务商要求填写",
  );
  await page.screenshot({ path: resolve(output, "mcp-hint.png") });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  if (await page.getByRole("button", { name: "展开侧栏", exact: true }).count())
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  let chosen = -1;
  let expectedTurns = 0;
  for (let index = 0; index < before[3].length; index++) {
    const messages = await get(
      `/conversations/${before[3][index].id}/messages`,
    );
    const count = messages.filter((m) => m.role === "user").length;
    if (count > 1) {
      chosen = index;
      expectedTurns = count;
      break;
    }
  }
  assert.ok(
    chosen >= 0,
    "An existing conversation with multiple turns is required",
  );
  await page
    .locator(".conversation-link > button:first-child")
    .nth(chosen)
    .click();
  await page.locator(".chat-turn-nav button").first().waitFor();
  const turnCount = await page.locator(".chat-turn-nav button").count();
  assert.equal(turnCount, expectedTurns);
  await page.locator(".chat-turn-nav button").last().click();
  await page.locator(".chat-turn-nav button").first().click();
  await page.waitForFunction(() => {
    const scroll = document.querySelector(".chat-scroll");
    const first = document.querySelector(".message.user");
    return (
      first &&
      Math.abs(
        first.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top -
          24,
      ) < 3
    );
  });
  await page.screenshot({ path: resolve(output, "chat-turn-navigation.png") });
  await page.mouse.move(500, 50);
  await page
    .locator(".chat-turn-nav button")
    .evaluateAll((items) => items.forEach((e) => e.blur()));
  await page.waitForFunction(
    () =>
      parseFloat(
        getComputedStyle(
          document.querySelectorAll(".chat-turn-nav button")[1],
          "::after",
        ).width,
      ) <= 8,
  );
  const markerLayout = await page
    .locator(".chat-turn-nav button")
    .evaluateAll((items) => ({
      pitch:
        items[1].getBoundingClientRect().top -
        items[0].getBoundingClientRect().top,
      width: parseFloat(getComputedStyle(items[1], "::after").width),
    }));
  assert.ok(markerLayout.pitch <= 12.5);
  assert.ok(markerLayout.width <= 8);
  await page.screenshot({ path: resolve(output, "chat-turn-compact.png") });
  await page.locator(".chat-turn-nav button").first().hover();
  await page.locator(".chat-turn-preview").waitFor();
  const hoverPreview = await page
    .locator(".chat-turn-preview")
    .evaluate((e) => {
      const answer = e.querySelector(":scope > p");
      return {
        question: Boolean(e.querySelector(":scope > strong")?.textContent),
        answer: Boolean(answer.textContent),
        clamp: getComputedStyle(answer).webkitLineClamp,
        height: answer.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(answer).lineHeight),
      };
    });
  assert.ok(hoverPreview.question && hoverPreview.answer);
  assert.equal(hoverPreview.clamp, "3");
  assert.ok(hoverPreview.height <= hoverPreview.line * 3 + 1);
  await page.waitForFunction(
    () =>
      parseFloat(
        getComputedStyle(
          document.querySelector(".chat-turn-nav button"),
          "::after",
        ).width,
      ) >= 27,
  );
  await page.screenshot({
    path: resolve(output, "chat-turn-hover-preview.png"),
  });
  await page.mouse.move(500, 50);
  await page.locator(".chat-turn-preview").waitFor({ state: "hidden" });
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  const report = {
    descriptions: descriptions.length,
    padding,
    turnCount,
    markerLayout,
    hoverPreview,
    provider_preserved: true,
    business_data_unchanged: true,
    real_model_called: false,
    wechat_tested: false,
  };
  writeFileSync(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
