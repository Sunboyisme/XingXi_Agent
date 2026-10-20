// Read-only verification of the 0.1.4 feedback round on the persistent preview.
// It never submits a model request and never edits provider, memory or plan data.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const output = resolve(".local-data/ui-review-0.1.4");
mkdirSync(output, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9290");
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find(
      (item) =>
        item.url().startsWith("http://127.0.0.1:5190") &&
        !item.url().includes("view=reminder"),
    );
  assert.ok(page, "preview WebView must be reachable over CDP");
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const connection = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("backend_config"),
  );
  const token = readFileSync(
    resolve(".local-data/preview-runtime/auth-token"),
    "utf8",
  ).trim();
  assert.equal(connection.token, token);
  const get = async (path) => {
    const response = await fetch(connection.url + path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.ok(response.ok, path);
    return response.json();
  };

  await page.getByRole("button", { name: "对话", exact: true }).click();
  const composer = page.getByLabel("发送给XiaoXi的消息");
  await composer.waitFor();

  // One dropdown at a time (MCP ↔ skills).
  const mcp = page.getByRole("button", { name: "MCP 工具", exact: true });
  const skills = page.getByRole("button", { name: "技能", exact: true });
  await mcp.click();
  await page.getByRole("menuitem", { name: "配置 MCP", exact: true }).waitFor();
  await page.waitForTimeout(300);
  await skills.click();
  await page.getByRole("menuitem", { name: "管理技能", exact: true }).waitFor();
  await page.waitForTimeout(350);
  const openMenus = await page.locator(".toolbox-menu").evaluateAll((items) =>
    items.filter((item) => {
      const box = item.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        getComputedStyle(item).visibility !== "hidden"
      );
    }),
  );
  assert.equal(openMenus.length, 1, "only one composer menu may stay open");
  assert.equal(
    await page.locator(".skill-menu").isVisible(),
    true,
    "the skills menu is the one that stays open",
  );
  await page.screenshot({ path: resolve(output, "01-menu-switch.png") });
  await page.keyboard.press("Escape");

  // Draft survives navigation to another page and back.
  await composer.fill("c7 离开页面后应保留的草稿");
  await page.getByRole("button", { name: "学习", exact: true }).click();
  await page.locator(".learning-page").waitFor();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), "c7 离开页面后应保留的草稿");
  await page.screenshot({ path: resolve(output, "02-draft-restored.png") });
  await composer.fill("");

  // Authentication error: centered text plus a route into interface settings.
  await page.route("**/api/v1/conversations", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "接口认证失败，请检查密钥与接口地址。" }),
    }),
  );
  await composer.fill("触发接口错误");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const notice = page.locator(".error-notice").last();
  await notice.waitFor();
  assert.equal(
    await notice
      .locator(".error-notice-text")
      .evaluate((element) => getComputedStyle(element).textAlign),
    "center",
  );
  const configure = notice.getByRole("button", {
    name: "配置接口",
    exact: true,
  });
  assert.equal(await configure.isVisible(), true);
  await page.screenshot({ path: resolve(output, "03-auth-error.png") });
  await configure.click();
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.unroute("**/api/v1/conversations");
  await composer.fill("");

  // Connection result sits next to the dialog actions, not above the scroll area.
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page
    .getByRole("button", { name: /^编辑连接 / })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByLabel("连接名称").fill("");
  await dialog.getByRole("button", { name: "保存并测试", exact: true }).click();
  const status = dialog.locator(".model-dialog-status .error-notice");
  await status.waitFor();
  const statusBox = await status.boundingBox();
  const dialogBox = await dialog.boundingBox();
  assert.ok(statusBox && dialogBox);
  assert.ok(
    statusBox.y + statusBox.height <= dialogBox.y + dialogBox.height + 1,
    "the validation result must remain inside the visible dialog",
  );
  await page.screenshot({ path: resolve(output, "04-dialog-status.png") });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "对话", exact: true }).click();

  // Option label above its picture, and a stable image source.
  const conversations = await get("/conversations");
  let target = null;
  for (const conversation of conversations) {
    const messages = await get(`/conversations/${conversation.id}/messages`);
    if (
      messages.some(
        (item) =>
          item.role === "assistant" &&
          item.content.includes("![") &&
          /方案\s*[一二三1-9]/.test(item.content),
      )
    ) {
      target = conversation;
      break;
    }
  }
  let layout = null;
  if (target) {
    await page
      .locator(".conversation-link > button:first-child")
      .filter({ hasText: target.title })
      .first()
      .click();
    const picture = page.locator(".markdown .output-picture img").last();
    await picture.waitFor();
    await picture.evaluate((element) => element.decode?.());
    layout = await page
      .locator(".markdown p:has(.output-picture)")
      .last()
      .evaluate((element) => {
        const image = element.querySelector(".output-picture");
        const strong = element.querySelector("strong");
        const text = [...element.childNodes].find(
          (node) => node.nodeType === 3 && node.textContent.trim(),
        );
        let labelBottom = null;
        if (strong) labelBottom = strong.getBoundingClientRect().bottom;
        else if (text) {
          const range = document.createRange();
          range.selectNodeContents(text);
          labelBottom = range.getBoundingClientRect().bottom;
        }
        return {
          display: getComputedStyle(element).display,
          direction: getComputedStyle(element).flexDirection,
          labelBottom,
          imageTop: image.getBoundingClientRect().top,
        };
      });
    assert.equal(layout.display, "flex");
    assert.equal(layout.direction, "column");
    assert.ok(
      layout.labelBottom === null || layout.labelBottom <= layout.imageTop + 1,
      "the option label must sit above the picture",
    );
    const source = await picture.getAttribute("src");
    assert.ok(source);
    await page.waitForTimeout(1500);
    assert.equal(await picture.getAttribute("src"), source);
    assert.equal(await picture.isVisible(), true);
    await page.screenshot({ path: resolve(output, "05-labelled-poster.png") });
  }

  // Native download goes to the Windows Downloads folder, not the data folder.
  let card = page.locator(".office-file-card").last();
  let downloaded = "";
  if (!(await card.count())) {
    const links = page.locator(".conversation-link > button:first-child");
    for (let index = 0; index < Math.min(await links.count(), 8); index++) {
      await links.nth(index).click();
      await page.waitForTimeout(400);
      if (await page.locator(".office-file-card").count()) {
        card = page.locator(".office-file-card").last();
        break;
      }
    }
  }
  if (await card.count()) {
    await card.getByRole("button", { name: /^下载 / }).click();
    const result = page.locator(".download-result-dialog");
    await result.getByText("文件已下载", { exact: true }).waitFor();
    downloaded = (
      await result.locator(".download-result-path code").textContent()
    ).trim();
    assert.match(downloaded, /^[A-Za-z]:[\\/].*[\\/]Downloads[\\/]/i);
    assert.equal(existsSync(downloaded), true);
    assert.equal(
      await result
        .getByRole("button", { name: "打开所在文件夹", exact: true })
        .isVisible(),
      true,
    );
    await page.screenshot({ path: resolve(output, "06-download.png") });
    await result.getByRole("button", { name: "知道了", exact: true }).click();
  }

  assert.deepEqual(errors, []);
  const report = {
    menus: openMenus.length,
    draft_restored: true,
    error_notice_centered: true,
    configure_entry: true,
    dialog_status_visible: true,
    label_layout: layout,
    labelled_poster_sample: Boolean(target),
    image_stable: target ? true : null,
    downloaded,
    real_model_called: false,
    provider_or_plan_writes: false,
  };
  writeFileSync(
    resolve(output, "feedback014b-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
