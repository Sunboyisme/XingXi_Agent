import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

test.skip(process.env.BAI_018_QA !== "1", "Requires the dedicated qa018 fixture");
const output = resolve(".local-data/qa018/screenshots");
test.beforeAll(() => mkdirSync(output, { recursive: true }));
test.beforeEach(async ({ page, request }) => {
  const data = await request.get("/api/v1/settings/data").then((response) => response.json());
  expect(data.directory).toContain("qa018");
  await page.goto("/");
  await page.getByRole("button", { name: "学习", exact: true }).waitFor();
});

test("guided goal, top completion, review evidence and responsive frosted composer", async ({ page, request }) => {
  await page.getByRole("button", { name: "学习", exact: true }).click();
  if (await page.getByRole("button", { name: "所有学习目标", exact: true }).isVisible()) await page.getByRole("button", { name: "所有学习目标", exact: true }).click();
  await page.getByRole("button", { name: "新的学习目标" }).click();
  await expect(page.getByText("XiaoXi 会帮你规划好适合你的学习路线。", { exact: true })).toBeVisible();
  const intake = page.getByRole("textbox", { name: "学习目标对话" });
  await intake.fill("我想学HTML，能够理解页面结构");
  await page.getByRole("button", { name: "发送回答", exact: true }).click();
  await expect(page.getByText("你目前有什么基础？", { exact: true })).toBeVisible();
  await intake.fill("零基础");
  await page.getByRole("button", { name: "发送回答", exact: true }).click();
  await expect(page.getByRole("region", { name: "学习目标摘要" })).toBeVisible();
  await page.getByRole("button", { name: "确认并生成学习路线" }).click();
  await page.getByRole("button", { name: "开始这个知识点" }).click();
  const input = page.getByRole("textbox", { name: "练习回答", exact: true });
  await expect(input).toBeVisible();
  await expect(page.getByText("检查标准", { exact: true })).toHaveCount(0);
  await expect(page.locator(".learning-section-navigation")).toHaveCount(0);
  await expect(page.locator(".learning-session-toolbar").getByRole("button", { name: "完成本章", exact: true })).toBeVisible();
  const before = await page.locator(".learning-composer").evaluate((element) => ({ border: getComputedStyle(element).borderColor, shadow: getComputedStyle(element).boxShadow }));
  await input.focus();
  expect(await page.locator(".learning-composer").evaluate((element) => ({ border: getComputedStyle(element).borderColor, shadow: getComputedStyle(element).boxShadow }))).toEqual(before);
  await input.fill("长文本\n".repeat(70));
  for (const [width, height] of [[700, 440], [1280, 720], [1600, 900]]) {
    await page.setViewportSize({ width, height });
    const geometry = await page.locator(".learning-composer").evaluate((element) => {
      const text = element.querySelector("textarea")!;
      const upload = element.querySelector(".attach-button")!.getBoundingClientRect();
      const send = element.querySelector(".learning-composer-tools > button:last-child")!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, upload: upload.x, send: send.x,
        toolsBelowText: send.y >= text.getBoundingClientRect().bottom - 1, bottom: box.bottom, height: innerHeight,
        border: getComputedStyle(text).borderWidth, shadow: getComputedStyle(text).boxShadow, backdrop: getComputedStyle(element).backdropFilter };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.upload).toBeLessThan(geometry.send);
    expect(geometry.toolsBelowText).toBe(true);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
    expect(geometry.border).toBe("0px");
    expect(geometry.shadow).toBe("none");
    expect(geometry.backdrop).toContain("blur");
    await page.screenshot({ path: resolve(output, `learning-${width}.png`) });
  }
  await input.fill("");
  await page.getByRole("button", { name: "完成本章", exact: true }).click();
  await page.getByRole("button", { name: "复习", exact: true }).click();
  await expect(page.getByRole("region", { name: "学习复习" })).toBeVisible();
  await expect(page.getByText("main 标签的作用是什么？", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "练习回答", exact: true }).fill("main 表示页面的主要内容");
  await page.getByRole("button", { name: "发送回答", exact: true }).click();
  await expect(page.getByText("这次练习通过了", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "再来一题" })).toBeVisible();
  const goals = await request.get("/api/v1/learning/goals").then((response) => response.json());
  expect(goals.find((goal: any) => goal.title === "HTML隔离验收").nodes[0].status).toBe("passed");
  await page.screenshot({ path: resolve(output, "review-result.png") });
});

test("project library is a page and markdown is rendered from the original source", async ({ page, request }) => {
  const project = await request.post("/api/v1/projects", { data: { name: "资料页验收" } }).then((response) => response.json());
  const upload = await request.post(`/api/v1/projects/${project.id}/materials/upload`, { multipart: { file: {
    name: "说明.md", mimeType: "text/markdown", buffer: Buffer.from("# 渲染标题\n\n第一段。\n\n- 甲\n- 乙\n\n```js\nconst x = 1;\n```\n") } } });
  expect(upload.ok()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: /资料页验收/ }).click();
  await page.getByRole("button", { name: /^资料库/ }).click();
  await expect(page.getByRole("region", { name: "项目资料库" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "预览 说明.md", exact: true }).click();
  await expect(page.getByRole("heading", { name: "渲染标题", exact: true })).toBeVisible();
  await expect(page.locator(".office-preview-body ul li")).toHaveCount(2);
  await expect(page.locator(".office-preview-body pre code")).toContainText("const x = 1;");
  await page.screenshot({ path: resolve(output, "markdown-rendered.png") });
});
