// Read-only on real preview: no uploads, submissions, lessons generated or model calls.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(".local-data/real-preview-check/learning-answer");
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
    const r = await fetch(connection.url + path, {
      headers: { Authorization: `Bearer ${connection.token}` },
    });
    assert.ok(r.ok);
    return r.json();
  };
  const snapshot = () =>
    Promise.all([
      get("/settings"),
      get("/learning/goals"),
      get("/settings/data"),
    ]);
  const before = await snapshot();
  assert.ok(before[0].model_configured);
  let chosen;
  for (const goal of before[1]) {
    for (const node of goal.nodes) {
      const lesson = await get(`/learning/nodes/${node.id}/lesson`);
      if (lesson?.state === "awaiting_submission") {
        chosen = { goal, node };
        break;
      }
    }
    if (chosen) break;
  }
  assert.ok(chosen, "Existing lesson awaiting an answer is required");
  const writes = [],
    errors = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/v1/"))
      writes.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  if (!(await page.getByRole("region", { name: "练习作答区" }).isVisible())) {
    await page.getByRole("button", { name: "学习", exact: true }).click();
    if (
      await page
        .getByRole("button", { name: "所有学习目标", exact: true })
        .count()
    )
      await page
        .getByRole("button", { name: "所有学习目标", exact: true })
        .click();
    await page
      .locator(".goal-card")
      .filter({
        has: page.getByRole("heading", {
          name: chosen.goal.title,
          exact: true,
        }),
      })
      .click();
    await page
      .locator(".outline-node")
      .nth(chosen.goal.nodes.findIndex((n) => n.id === chosen.node.id))
      .click();
  }
  const dock = page.getByRole("region", { name: "练习作答区" });
  await dock.waitFor();
  const initial = await dock.boundingBox();
  await page.locator(".lesson-scroll").evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  const after = await dock.boundingBox();
  assert.ok(Math.abs(initial.y - after.y) < 1);
  assert.ok(Math.abs(initial.height - after.height) < 1);
  const layout = await page.locator(".lesson-content").evaluate((e) => {
    const dock = e
      .querySelector(".exercise-answer-dock")
      .getBoundingClientRect();
    const scroll = e.querySelector(".lesson-scroll").getBoundingClientRect();
    return {
      dockBottom: dock.bottom,
      panelBottom: e.getBoundingClientRect().bottom,
      scrollBottom: scroll.bottom,
      dockTop: dock.top,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.ok(Math.abs(layout.dockBottom - layout.panelBottom) < 1);
  assert.ok(layout.scrollBottom <= layout.dockTop + 1);
  assert.equal(layout.overflow, false);
  const attachments = await dock.evaluate((e) => ({
    overflowY: getComputedStyle(e).overflowY,
    scrollHeight: e.scrollHeight,
    clientHeight: e.clientHeight,
    thumbnails: e.querySelectorAll(".attachment-draft img").length,
    names: e.querySelectorAll(".attachment-names small").length,
  }));
  assert.equal(attachments.overflowY, "hidden");
  assert.ok(attachments.scrollHeight <= attachments.clientHeight + 1);
  assert.equal(attachments.thumbnails, 0);
  await page.screenshot({ path: resolve(output, "native-answer-dock.png") });
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  const report = {
    fixed_dock: true,
    layout,
    attachments,
    real_provider_preserved: true,
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
