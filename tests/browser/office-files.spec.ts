import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

test.skip(
  process.env.BAI_OFFICE_QA !== "1",
  "Requires isolated office QA environment",
);

test("upload Word/PDF, read via tools, generate and preview/download office files", async ({
  page,
  request,
}) => {
  const data = await request.get("/api/v1/settings/data").then((r) => r.json());
  expect(data.directory).toContain(process.env.BAI_QA_DATA_MARKER || "qa-office");
  await request.put("/api/v1/settings", {
    data: {
      model_url: process.env.BAI_MOCK_URL || "http://127.0.0.1:8896/v1",
      model_name: "mock-test",
      model_key: "synthetic-office-key",
      vision_enabled: false,
    },
  });
  await page.goto("/");
  await page.locator('input[type="file"]').first().setInputFiles([
      resolve(".local-data/qa-office/fixtures/source.docx"),
      resolve(".local-data/qa-office/fixtures/source.pdf"),
    ]);
  await expect(page.getByText("可读取", { exact: true })).toHaveCount(1, {
    timeout: 20000,
  });
  await expect(page.getByText("部分解析", { exact: true })).toHaveCount(1, {
    timeout: 20000,
  });
  await page
    .getByLabel("发送给XiaoXi的消息")
    .fill("office-contract 请读取Word和PDF，生成Word报告和Excel明细表");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "预览 办公报告.docx", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("button", { name: "预览 项目明细.xlsx", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "预览 办公报告.docx", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("预算100元");
  const shots = resolve(".local-data/qa-office/screenshots");
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, "word-preview.png") });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page
    .getByRole("button", { name: "预览 项目明细.xlsx", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("cell", { name: "100.0", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(shots, "excel-preview.png") });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 办公报告.docx", exact: true })
    .click();
  expect((await download).suggestedFilename()).toBe("办公报告.docx");
  await page
    .getByRole("button", { name: "预览 source.pdf", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "PDF 第 1 页", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(shots, "pdf-preview.png") });
});
