import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(
  process.env.BAI_CONTEXT_QA !== "1",
  "Requires isolated context QA data",
);
test.describe.configure({ mode: "default" });

test("Bailian search preset saves the correct disabled connection without contacting the provider", async ({
  page,
  request,
}) => {
  const calls: string[] = [];
  page.on("request", (value) => {
    if (value.method() === "POST") calls.push(value.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "工具", exact: true }).click();
  await page.getByRole("button", { name: "添加 MCP", exact: true }).click();
  await page.getByRole("button", { name: "百炼联网搜索", exact: true }).click();
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue(
    "百炼联网搜索",
  );
  await expect(page.getByLabel("服务地址", { exact: true })).toHaveValue(
    "https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp",
  );
  await expect(
    page.getByLabel("百炼 API 密钥", { exact: true }),
  ).toHaveAttribute("type", "text");
  await page.screenshot({
    path: ".local-data/context-review-20261017/mcp-bailian-preset.png",
  });
  await page
    .getByLabel("百炼 API 密钥", { exact: true })
    .fill("synthetic-bailian-search-key");
  const saved = page.waitForResponse(
    (value) =>
      value.request().method() === "POST" &&
      value.url().endsWith("/mcp/servers"),
  );
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const server = await response.json();
  expect(server.enabled).toBe(false);
  expect(server.headers).toEqual({ Authorization: true });
  expect(JSON.stringify(server)).not.toContain("synthetic-bailian-search-key");
  expect(calls.filter((url) => url.endsWith("/test"))).toEqual([]);
  expect((await request.delete(`/api/v1/mcp/servers/${server.id}`)).ok()).toBe(
    true,
  );
});

test("drag image, thumbnail, zoom, send and restore provider reasoning", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const image = readFileSync(
    ".local-data/context-review-20261017/input.png",
  ).toString("base64");
  const transfer = await page.evaluateHandle((base64) => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))],
        "preview.png",
        { type: "image/png" },
      ),
    );
    return data;
  }, image);
  await page
    .locator(".chat-layout")
    .dispatchEvent("drop", { dataTransfer: transfer });
  await expect(
    page.getByRole("button", { name: "放大 preview.png" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".attachment-draft img")
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.screenshot({
    path: ".local-data/context-review-20261017/browser-draft.png",
  });
  await page.getByRole("button", { name: "放大 preview.png" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("发送给XiaoXi的消息").fill("分析这张测试图片");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const reasoning = page.locator(".reasoning-toggle");
  await expect(reasoning).toHaveAttribute("aria-expanded", "true");
  await reasoning.click();
  await expect(reasoning).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".message.assistant")).toContainText(
    "本地协议测试服务",
  );
  await reasoning.click();
  await expect(page.locator(".reasoning-content")).toContainText("本地模拟");
  await page.screenshot({
    path: ".local-data/context-review-20261017/browser-reasoning.png",
  });
  await page.reload();
  await page
    .locator(".conversation-link > button:first-child")
    .filter({ hasText: "分析这张测试图片" })
    .first()
    .click();
  await expect(page.locator(".reasoning-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.locator(".reasoning-toggle").click();
  await expect(page.locator(".reasoning-content")).toContainText("本地模拟");
  await expect
    .poll(() =>
      page
        .locator(".message-pictures img")
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.setViewportSize({ width: 700, height: 620 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local-data/context-review-20261017/browser-narrow.png",
  });
  expect(errors).toEqual([]);
});

test("embedding settings save without returning a key, test the local server and show indexing", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  const section = page.getByRole("region", { name: "语义记忆检索" });
  await expect(section).toBeVisible();
  await expect(section).toContainText("已索引 2 / 2", { timeout: 15000 });
  await section.getByRole("button", { name: "配置语义记忆检索" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "测试连接", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("连接成功 · 3 维");
  const status = await (await request.get("/api/v1/settings/embedding")).text();
  expect(status).not.toContain("synthetic-embedding-key");
  await page.screenshot({
    path: ".local-data/context-review-20261017/browser-embedding.png",
  });
});

test("connection cards and retrieval inspection work at desktop and narrow widths", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await expect(page.locator(".service-card")).toHaveCount(3);
  await expect(page.getByLabel("Embedding 接口地址")).toHaveCount(0);
  await expect(page.locator(".lucide-brain")).toHaveCount(0);
  await page.screenshot({
    path: ".local-data/context-review-20261017/connections-cards.png",
  });
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await page.getByRole("button", { name: "试着查找记忆", exact: true }).click();
  await page.getByLabel("检索测试问题").fill("言简意赅");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("偏好精炼答复");
  await expect(page.getByRole("dialog")).toContainText("语义 1.000");
  await expect(page.getByRole("dialog")).toContainText("未达到语义阈值");
  await page.screenshot({
    path: ".local-data/context-review-20261017/retrieval-preview.png",
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page
    .locator(".conversation-link > button:first-child")
    .filter({ hasText: "分析这张测试图片" })
    .first()
    .click();
  await page.getByRole("button", { name: "参考的记忆", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("分析这张测试图片");
  await expect(page.getByLabel("检索测试问题")).toHaveCount(0);
  await page.screenshot({
    path: ".local-data/context-review-20261017/retrieval-record.png",
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.setViewportSize({ width: 720, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local-data/context-review-20261017/connections-narrow.png",
  });
  expect(errors).toEqual([]);
});
