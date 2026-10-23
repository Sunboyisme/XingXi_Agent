import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.skip(process.env.BAI_CONTEXT_QA !== "1", "Requires isolated UI QA data");

test("data settings export, inspect, stage and cancel an isolated archive", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "连接与设置", exact: true }).click();
  await page.getByRole("tab", { name: "数据", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本机数据" })).toBeVisible();
  await expect(page.locator(".data-paths")).toContainText(
    process.env.BAI_QA_DATA_MARKER || "context-review-20261017",
  );
  await expect(page.locator(".data-paths")).toContainText("bai.sqlite");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出数据", exact: true }).click();
  const archive = await downloading;
  const path = ".local-data/context-review-20261017/browser-data-export.zip";
  await archive.saveAs(path);
  expect((await readFile(path)).length).toBeGreaterThan(1000);
  await expect(page.getByRole("status")).toContainText("已导出到");
  await page.getByLabel("选择 XiaoXi 数据文件").setInputFiles(path);
  await expect(page.getByRole("dialog", { name: "导入数据" })).toContainText(
    "将替换当前",
  );
  await expect(page.getByRole("dialog").locator(".data-counts")).toContainText(
    "向量",
  );
  await page.screenshot({
    path: ".local-data/context-review-20261017/data-import-preview.png",
  });
  await page.getByRole("button", { name: "确认导入，重启后恢复" }).click();
  await expect(page.getByText(/数据已准备好/)).toBeVisible();
  await page.getByRole("button", { name: "取消待导入" }).click();
  await expect(page.getByText(/数据已准备好/)).toHaveCount(0);
  await page.setViewportSize({ width: 720, height: 800 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: ".local-data/context-review-20261017/data-settings-narrow.png",
  });
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.screenshot({
    path: ".local-data/context-review-20261017/data-settings.png",
  });
  expect(errors).toEqual([]);
});
