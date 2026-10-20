import { test, expect } from "@playwright/test";

test.skip(
  process.env.BAI_CONTEXT_QA !== "1",
  "Requires isolated QA backend with MCP_QA_HTTP_KEY and local MCP fixture",
);

test("compact tool groups, environment authentication, readable editing and missing-variable feedback", async ({
  page,
  request,
}) => {
  const ids: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const suffix = String(Date.now());
  const names = [`示例搜索 ${suffix}`, `待配置服务 ${suffix}`];
  try {
    for (const [index, name] of names.entries()) {
      const response = await request.post("/api/v1/mcp/servers", {
        data: {
          name,
          transport: "streamable_http",
          url: "http://127.0.0.1:8898/mcp",
          headers: index
            ? { Authorization: "Bearer ${MCP_QA_MISSING_BROWSER}" }
            : { "X-Test-Key": "${MCP_QA_HTTP_KEY}" },
        },
      });
      expect(response.ok()).toBe(true);
      ids.push((await response.json()).id);
    }
    await page.goto("/");
    await page.getByRole("button", { name: "连接与设置", exact: true }).click();
    await page.getByRole("tab", { name: "工具", exact: true }).click();
    const builtin = page.getByRole("button", { name: /内置工具/ });
    await expect(builtin).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("checkbox", { name: "启用 内置工具 · 计算器" }),
    ).toHaveCount(0);
    await builtin.click();
    await expect(
      page.getByRole("checkbox", { name: "启用 内置工具 · 计算器" }),
    ).toBeVisible();
    await builtin.click();
    const first = page.getByRole("region", { name: `MCP 服务 ${names[0]}` });
    const missing = page.getByRole("region", { name: `MCP 服务 ${names[1]}` });
    await first
      .getByRole("button", { name: "测试 / 刷新工具", exact: true })
      .click();
    await expect(
      first.getByRole("checkbox", {
        name: `启用 ${names[0]} · echo`,
        exact: true,
      }),
    ).toBeVisible();
    await first
      .getByRole("checkbox", { name: `启用 ${names[0]} · echo`, exact: true })
      .click();
    await first.getByRole("button", { name: "启用服务", exact: true }).click();
    await expect(first.locator(".connection-label")).toHaveText("已连接");
    await first
      .getByRole("button", { name: `管理 ${names[0]} 的工具` })
      .click();
    await missing
      .getByRole("button", { name: "测试 / 刷新工具", exact: true })
      .click();
    await expect(missing.locator(".mcp-connection-error")).toContainText(
      "MCP_QA_MISSING_BROWSER",
    );
    await expect(missing.getByRole("alert")).toHaveCount(0);
    const one = await first.boundingBox(),
      two = await missing.boundingBox();
    expect(Math.abs(one!.y - two!.y)).toBeLessThan(2);
    expect(one!.height).toBeLessThan(260);
    await page.screenshot({
      path: ".local-data/context-review-20261017/tools-compact-desktop.png",
    });
    await first.getByRole("button", { name: "编辑", exact: true }).click();
    const value = page.getByLabel("请求头值 1", { exact: true });
    await expect(value).toHaveValue("${MCP_QA_HTTP_KEY}");
    await expect(value).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "隐藏请求头值 1" }).click();
    await expect(value).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "显示请求头值 1" }).click();
    await expect(value).toHaveAttribute("type", "text");
    await page.screenshot({
      path: ".local-data/context-review-20261017/mcp-environment-reference.png",
    });
    await page.keyboard.press("Escape");
    await page.getByLabel("搜索工具", { exact: true }).fill("echo");
    await expect(
      first.getByRole("checkbox", {
        name: `启用 ${names[0]} · echo`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByLabel("搜索工具", { exact: true }).fill("");
    await page.setViewportSize({ width: 720, height: 800 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: ".local-data/context-review-20261017/tools-compact-narrow.png",
    });
    expect(errors).toEqual([]);
  } finally {
    for (const id of ids) await request.delete(`/api/v1/mcp/servers/${id}`);
  }
});
