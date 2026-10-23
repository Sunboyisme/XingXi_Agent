import { test, expect, type Page } from "@playwright/test";

test.skip(
  process.env.BAI_MCP_QA !== "1",
  "Requires isolated local MCP fixture",
);
test.describe.configure({ mode: "default" });
async function openTools(page: Page) {
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "工具", exact: true }).click();
}
test("MCP import, test, selection, mixed chat and persisted records", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = process.env.BAI_MCP_FIXTURE_URL!;
  for (const server of await (await request.get("/api/v1/mcp/servers")).json())
    await request.delete(`/api/v1/mcp/servers/${server.id}`);
  await request.put("/api/v1/settings", {
    data: { model_url: process.env.BAI_MOCK_URL, model_name: "mock-test" },
  });
  await page.goto("/");
  await openTools(page);
  await page.getByRole("button", { name: "导入 JSON" }).click();
  await page.getByLabel("mcpServers JSON").fill(
    JSON.stringify({
      mcpServers: {
        "测试 MCP": {
          url,
          headers: { "X-Test-Key": "synthetic-mcp-secret" },
        },
      },
    }),
  );
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.getByLabel("导入预览")).not.toContainText(
    "synthetic-mcp-secret",
  );
  expect(await (await request.get("/api/v1/mcp/servers")).json()).toEqual([]);
  await page.getByRole("button", { name: "确认导入" }).click();
  const section = page.getByRole("region", { name: "MCP 服务 测试 MCP" });
  await expect(section).toContainText("已停用");
  await section.getByRole("button", { name: "测试 / 刷新工具" }).click();
  const echo = section.getByRole("checkbox", {
    name: "启用 测试 MCP · echo",
    exact: true,
  });
  await expect(echo).toBeVisible();
  await expect(echo).not.toBeChecked();
  await echo.click();
  await expect(echo).toBeChecked();
  await section.getByRole("button", { name: "启用服务", exact: true }).click();
  await expect(section).toContainText("已连接", { timeout: 20000 });
  await page.screenshot({
    path: ".local-data/mcp-review/tools-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByLabel("发送给XiaoXi的消息").fill("组合MCP，先计算再回显");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByText("组合工具已执行。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "工具调用结果" }).click();
  await expect(page.locator(".answer-tools-dialog")).toContainText("测试 MCP");
  await expect(page.locator(".answer-tools-dialog")).toContainText("echo");
  await page.reload();
  await page
    .getByRole("button", { name: "组合MCP，先计算再回显", exact: false })
    .first()
    .click();
  await page.getByRole("button", { name: "工具调用结果" }).click();
  await expect(page.locator(".answer-tools-dialog")).toContainText("echo");
  await page.keyboard.press("Escape");
  await openTools(page);
  await expect(
    section.getByRole("checkbox", {
      name: "启用 测试 MCP · echo",
      exact: true,
    }),
  ).toBeChecked();
  await page.setViewportSize({ width: 720, height: 800 });
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 720);
  await page.screenshot({
    path: ".local-data/mcp-review/tools-720.png",
    fullPage: true,
  });
  await section.getByRole("button", { name: "停用服务", exact: true }).click();
  await expect(section).toContainText("已停用");
  await request.delete(
    `/api/v1/mcp/servers/${(await (await request.get("/api/v1/mcp/servers")).json())[0].id}`,
  );
  expect(errors).toEqual([]);
});

test("tabs keep drafts, memory lives in settings, and builtin switches persist", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "记忆", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  const original = await page
    .getByLabel("Tavily API 密钥", { exact: true })
    .inputValue();
  await page
    .getByLabel("Tavily API 密钥", { exact: true })
    .fill("unsaved-tab-draft");
  await page.getByRole("tab", { name: "工具", exact: true }).click();
  const calculate = page.getByRole("checkbox", {
    name: "启用 内置工具 · 计算器",
    exact: true,
  });
  await calculate.click();
  await expect(calculate).not.toBeChecked();
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/v1/tools")).json()).find(
          (x: { id: string }) => x.id === "calculate",
        ).enabled,
    )
    .toBe(false);
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  await expect(page.getByLabel("记忆保存方式")).toBeVisible();
  await page.getByRole("tab", { name: "连接", exact: true }).click();
  await expect(page.getByLabel("Tavily API 密钥", { exact: true })).toHaveValue(
    "unsaved-tab-draft",
  );
  await page.getByLabel("Tavily API 密钥", { exact: true }).fill(original);
  await page.reload();
  await openTools(page);
  await expect(calculate).not.toBeChecked();
  await calculate.click();
  await expect(calculate).toBeChecked();
});
