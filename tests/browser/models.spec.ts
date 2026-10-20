import { test, expect, type Page } from "@playwright/test";

test.skip(process.env.BAI_MODELS_QA !== "1", "Requires isolated model QA data");
test.describe.configure({ mode: "serial" });

async function select(page: Page, label: string, name: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

test("multiple named connections, model defaults and thinking persist", async ({
  page,
  request,
}) => {
  const previous = await (await request.get("/api/v1/settings")).json();
  for (const connection of previous.providers)
    await request.delete(`/api/v1/settings/providers/${connection.id}`);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "默认服务商", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  await page.getByRole("combobox", { name: "服务商", exact: true }).click();
  for (const name of ["阿里云百炼", "DeepSeek", "Kimi", "智谱", "硅基流动"])
    await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
  await page.getByRole("option", { name: "DeepSeek", exact: true }).click();
  await expect(page.getByLabel("接口地址", { exact: true })).toHaveValue(
    "https://api.deepseek.com/v1",
  );
  await page.getByLabel("连接名称", { exact: true }).fill("工作模型");
  await page
    .getByLabel("接口地址", { exact: true })
    .fill(process.env.BAI_MOCK_URL || "http://127.0.0.1:8937/v1");
  await page.getByLabel("API 密钥", { exact: true }).fill("synthetic-ui-key");
  await page.getByLabel("模型名称", { exact: true }).fill("first");
  await page.getByLabel("模型名称 2", { exact: true }).fill("second");
  await page.locator(".model-advanced > summary").nth(0).click();
  await select(page, "模型 1 思考配置", "thinking.type 开关");
  await page.locator(".model-advanced > summary").nth(1).click();
  await select(page, "模型 2 思考配置", "thinking.type 开关");
  await page.getByLabel("模型名称", { exact: true }).focus();
  expect(
    await page
      .getByLabel("模型名称", { exact: true })
      .evaluate((el) => getComputedStyle(el).outlineStyle),
  ).toBe("none");
  await page.screenshot({
    path: ".local-data/model-review-20261017/connection-editor.png",
  });
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "编辑连接 工作模型", exact: true }),
  ).toBeVisible();
  // A second connection to the same provider has a separate key, URL and model list.
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  await select(page, "服务商", "DeepSeek");
  await page.getByLabel("连接名称", { exact: true }).fill("备用模型");
  await page
    .getByLabel("接口地址", { exact: true })
    .fill(process.env.BAI_MOCK_URL || "http://127.0.0.1:8937/v1");
  await page
    .getByLabel("API 密钥", { exact: true })
    .fill("synthetic-backup-key");
  await page.getByLabel("模型名称", { exact: true }).fill("backup");
  await page.getByRole("button", { name: "移除模型 2" }).click();
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(page.locator(".connection-card")).toHaveCount(2);
  await select(page, "默认模型", "备用模型 · backup");
  await expect(
    page.getByRole("combobox", { name: "默认模型", exact: true }),
  ).toContainText("备用模型 · backup");
  const settings = await (await request.get("/api/v1/settings")).json();
  expect(settings.providers).toHaveLength(2);
  expect(
    settings.providers.every(
      (x: { provider_type: string }) => x.provider_type === "deepseek",
    ),
  ).toBe(true);
  expect(settings.model_name).toBe("backup");
  expect(JSON.stringify(settings)).not.toContain("synthetic-ui-key");
  await page.screenshot({
    path: ".local-data/model-review-20261017/connections-list.png",
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "选择模型", exact: true }),
  ).toContainText("backup");
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("menuitem", { name: /first 工作模型/ }).click();
  await page.getByRole("button", { name: "思考模式" }).click();
  const sent = page.waitForRequest(
    (req) =>
      req.method() === "POST" &&
      /\/conversations\/[^/]+\/messages$/.test(req.url()),
  );
  await page.getByLabel("发送给XiaoXi的消息").fill("你好");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const selection = (await sent).postDataJSON().model_selection;
  expect(selection.model_name).toBe("first");
  expect(selection.thinking_enabled).toBe(true);
  expect(selection.provider_id).toBe(
    settings.providers.find((x: { label: string }) => x.label === "工作模型")
      .id,
  );
  await expect(page.locator(".message.assistant")).toContainText(
    "本地协议测试服务",
  );
  await page.getByRole("button", { name: "思考模式" }).click();
  await expect(page.getByRole("button", { name: "思考模式" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await expect(page.locator(".connection-card")).toHaveCount(2);
  await page
    .getByRole("button", { name: "编辑连接 工作模型", exact: true })
    .click();
  await expect(page.getByLabel("API 密钥", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("模型名称 2", { exact: true })).toHaveValue(
    "second",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  expect(errors).toEqual([]);
});

test("MCP menu omits built-ins and persists toggles without closing", async ({
  page,
}) => {
  const remote = {
    id: "mcp_test",
    name: "读取资料",
    description: "读取外部资料",
    available: true,
    note: "已启用",
    enabled: true,
    source: "mcp",
    source_label: "本地测试",
    server_id: "demo",
    parameters: {},
  };
  const builtin = {
    ...remote,
    id: "calculate",
    name: "计算器",
    source: "builtin",
  };
  let enabled = true;
  await page.route("**/api/v1/tools", (route) =>
    route.fulfill({ json: [builtin, { ...remote, enabled }] }),
  );
  await page.route("**/api/v1/tools/mcp_test", (route) => {
    enabled = route.request().postDataJSON().enabled;
    return route.fulfill({ json: { ...remote, enabled } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "MCP 工具", exact: true }).click();
  const item = page.getByRole("menuitemcheckbox", { name: /读取资料/ });
  await expect(item).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemcheckbox", { name: /计算器/ }),
  ).toHaveCount(0);
  await item.click();
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "MCP 工具", exact: true }).click();
  await expect(item).toHaveAttribute("aria-checked", "false");
  await item.click();
  await expect(item).toHaveAttribute("aria-checked", "true");
});

test("memory dropdown supports keyboard selection and cream menu", async ({
  page,
  request,
}) => {
  await request.patch("/api/v1/settings/memory", {
    data: { memory_mode: "auto" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "记忆", exact: true }).click();
  const trigger = page.getByRole("combobox", { name: "记忆保存方式" });
  await trigger.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("End");
  await page.screenshot({
    path: ".local-data/model-review-20261017/memory-select.png",
  });
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText("每次确认");
  expect(
    (await (await request.get("/api/v1/settings")).json()).memory_mode,
  ).toBe("confirm");
  await expect(trigger).toBeFocused();
});

test("connection editor keeps actions visible in a short narrow window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 480 });
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("button", { name: "添加连接", exact: true }).click();
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  const dialog = await page.getByRole("dialog").boundingBox();
  const save = await page
    .getByRole("button", { name: "保存连接", exact: true })
    .boundingBox();
  expect(dialog!.y).toBeGreaterThanOrEqual(0);
  expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(480);
  expect(save!.y + save!.height).toBeLessThanOrEqual(480);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    700,
  );
});
