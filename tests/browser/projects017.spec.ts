import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

test.skip(
  process.env.BAI_017_QA !== "1",
  "Requires isolated 0.1.7 QA services",
);
const shots = resolve(".local-data/qa-017a/screenshots");
const workspace = resolve(".local-data/qa-017a/workspace");
test.beforeAll(() => {
  mkdirSync(shots, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    resolve(workspace, "说明.md"),
    "# 隔离测试资料\n预算100元。",
    "utf8",
  );
});
test.beforeEach(async ({ page, request }) => {
  const data = await request
    .get("/api/v1/settings/data")
    .then((response) => response.json());
  expect(data.directory).toContain("qa-017a");
  for (const project of await request
    .get("/api/v1/projects")
    .then((r) => r.json())) {
    await request.delete(`/api/v1/projects/${project.id}`);
  }
  for (const chat of await request
    .get("/api/v1/conversations")
    .then((r) => r.json())) {
    await request.delete(`/api/v1/conversations/${chat.id}`);
  }
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "连接与设置", exact: true }),
  ).toBeVisible();
});

test("styled project menu preserves draft and can assign a project", async ({
  page,
  request,
}) => {
  const project = await request
    .post("/api/v1/projects", { data: { name: "菜单项目" } })
    .then((r) => r.json());
  await page.reload();
  const input = page.getByLabel("发送给XiaoXi的消息");
  await input.fill("尚未发送的内容");
  await page.getByRole("button", { name: "新对话所属项目" }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "未加入项目" }),
  ).toBeVisible();
  await page
    .getByRole("menuitemradio", { name: project.name, exact: true })
    .click();
  await expect(input).toHaveValue("尚未发送的内容");
  await expect(page.locator(".composer .chat-project-context")).toContainText(
    project.name,
  );
  await expect(page.locator(".composer select")).toHaveCount(0);
  await page.screenshot({ path: resolve(shots, "a1-project-picker.png") });
});

test("project nesting, double-click rename and drag into project persist", async ({
  page,
  request,
}) => {
  const project = await request
    .post("/api/v1/projects", { data: { name: "拖入项目" } })
    .then((r) => r.json());
  const chat = await request
    .post("/api/v1/conversations", { data: { title: "可拖动对话" } })
    .then((r) => r.json());
  await page.reload();
  const source = page.getByRole("button", {
    name: "打开对话 可拖动对话",
    exact: true,
  });
  await source.dblclick();
  await page.getByLabel("对话名称", { exact: true }).fill("已经重命名");
  await page.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page
    .getByRole("button", { name: "打开对话 已经重命名", exact: true })
    .locator("..");
  const target = page.locator(".sidebar-project").filter({
    has: page.getByRole("button", {
      name: `打开项目 ${project.name}`,
      exact: true,
    }),
  });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer: transfer });
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(target).toHaveAttribute("data-drop-target", "true");
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(
    target.getByRole("button", { name: "打开对话 已经重命名" }),
  ).toBeVisible();
  const saved = await request
    .get("/api/v1/conversations")
    .then((r) => r.json());
  expect(saved.find((item: any) => item.id === chat.id).project_id).toBe(
    project.id,
  );
  const groupX = (await page.locator("#sidebar-projects-list").boundingBox())!
    .x;
  const headingX = (await target.locator(".project-heading").boundingBox())!.x;
  expect(headingX).toBeGreaterThan(groupX);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "打开对话 已经重命名" }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(shots, "a3-a5-sidebar.png") });
});

test("project workspace saves and remains scoped to the project", async ({
  page,
  request,
}) => {
  const project = await request
    .post("/api/v1/projects", { data: { name: "工作目录项目" } })
    .then((r) => r.json());
  await page.reload();
  await page
    .getByRole("button", { name: `打开项目 ${project.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "项目设置", exact: true }).click();
  await page.getByLabel("本地工作路径", { exact: true }).fill(workspace);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".project-workspace-path")).toContainText(
    workspace,
  );
  await page.reload();
  await page
    .getByRole("button", { name: `打开项目 ${project.name}`, exact: true })
    .click();
  await expect(page.locator(".project-workspace-path")).toContainText("只读");
  await page.screenshot({ path: resolve(shots, "a6-project-workspace.png") });
});

test("scroll and attachment errors cannot move the project bar over messages", async ({
  page,
  request,
}) => {
  const project = await request
    .post("/api/v1/projects", { data: { name: "布局检查" } })
    .then((r) => r.json());
  const chat = await request
    .post("/api/v1/conversations", {
      data: { title: "长对话布局", project_id: project.id },
    })
    .then((r) => r.json());
  const response = await request.post(
    `/api/v1/conversations/${chat.id}/messages`,
    { data: { content: "普通文字测试\n".repeat(100) } },
  );
  expect(response.ok()).toBeTruthy();
  const run = await response.json();
  await expect
    .poll(
      async () =>
        (await request.get(`/api/v1/runs/${run.id}`).then((r) => r.json()))
          .status,
      { timeout: 30000 },
    )
    .toMatch(/completed|failed/);
  await page.reload();
  await page
    .getByRole("button", { name: "打开对话 长对话布局", exact: true })
    .click();
  const dock = page.locator(".composer-area");
  const context = page.locator(".composer .chat-project-context");
  await expect(context).toBeVisible();
  for (const size of [
    { width: 1500, height: 950 },
    { width: 1000, height: 720 },
    { width: 760, height: 650 },
  ]) {
    await page.setViewportSize(size);
    const before = (await context.boundingBox())!.y;
    await page.locator(".chat-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(100);
    expect(Math.abs((await context.boundingBox())!.y - before)).toBeLessThan(2);
    const scroll = (await page.locator(".chat-scroll").boundingBox())!;
    expect(scroll.y + scroll.height).toBeLessThanOrEqual(
      (await dock.boundingBox())!.y + 2,
    );
  }
  await page.locator('input[type="file"]').setInputFiles({
    name: "不支持.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("test"),
  });
  await expect(page.locator(".composer-area .error-notice")).toBeVisible();
  const notice = (await page
    .locator(".composer-area .error-notice")
    .boundingBox())!;
  expect(notice.y + notice.height).toBeLessThanOrEqual(
    (await page.locator(".composer").boundingBox())!.y + 2,
  );
  await page.screenshot({ path: resolve(shots, "a2-a4-fixed-composer.png") });
});

test("finishing a delayed move keeps the conversation selected in the meantime", async ({
  page,
  request,
}) => {
  const project = await request
    .post("/api/v1/projects", { data: { name: "异步移动项目" } })
    .then((r) => r.json());
  const source = await request
    .post("/api/v1/conversations", { data: { title: "移动中的对话" } })
    .then((r) => r.json());
  await request.post("/api/v1/conversations", {
    data: { title: "我现在选择的对话" },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "打开对话 移动中的对话", exact: true })
    .click();
  let release: (() => void) | undefined;
  await page.route(`**/api/v1/conversations/${source.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response });
  });
  const row = page
    .getByRole("button", { name: "打开对话 移动中的对话", exact: true })
    .locator("..");
  const target = page
    .locator(".sidebar-project")
    .filter({
      has: page.getByRole("button", {
        name: `打开项目 ${project.name}`,
        exact: true,
      }),
    });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row.dispatchEvent("dragstart", { dataTransfer: transfer });
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await expect.poll(() => Boolean(release)).toBe(true);
  const current = page.getByRole("button", {
    name: "打开对话 我现在选择的对话",
    exact: true,
  });
  await current.click();
  release!();
  await expect(
    target.getByRole("button", { name: "打开对话 移动中的对话", exact: true }),
  ).toBeVisible();
  await expect(current).toHaveAttribute("aria-current", "page");
});
