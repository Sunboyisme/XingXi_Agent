import { test, expect } from "@playwright/test";

test.skip(
  process.env.BAI_FEEDBACK014C !== "1",
  "Requires isolated feedback014c-sim data",
);

test("loaded Markdown pictures survive scrolling and composer updates without jumping", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/runs**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith("/images")
      ? { id: "qa-picture", name: "隔离测试海报.svg", image: true }
      : path.endsWith("/presentation")
        ? { artifacts: [], sources: [], image_urls: [], errors: [] }
        : [];
    await route.fulfill({ json: data });
  });
  await page.route("**/api/v1/artifacts/qa-picture/content", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="900"><rect width="500" height="900" fill="#d8a178"/><text x="30" y="80" font-size="36">Isolated scroll fixture</text></svg>',
    }),
  );
  await page.goto("/");
  await page
    .locator(".conversation-link > button:first-child")
    .filter({ hasText: "隔离图片滚动回归" })
    .click();
  const pictures = page.locator(".markdown .output-picture img");
  await expect(pictures).toHaveCount(4);
  await expect
    .poll(() =>
      pictures.evaluateAll((items) =>
        items.every((item) => (item as HTMLImageElement).naturalHeight > 0),
      ),
    )
    .toBe(true);
  await pictures.evaluateAll((items) =>
    items.forEach((item, i) =>
      item.setAttribute("data-qa-identity", String(i)),
    ),
  );
  const scroller = page.locator(".chat-scroll");
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -700);
  await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
  // Wait for the wheel animation to settle, then trigger unrelated rerenders.
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeGreaterThan(400);
  await page.waitForTimeout(300);
  const top = await scroller.evaluate((el) => el.scrollTop);
  await page
    .getByLabel("发送给XiaoXi的消息")
    .fill("输入内容也不应影响历史图片");
  await page.getByRole("button", { name: "MCP 工具", exact: true }).click();
  await page.keyboard.press("Escape");
  expect(
    await pictures.evaluateAll((items) =>
      items.map((item) => item.getAttribute("data-qa-identity")),
    ),
  ).toEqual(["0", "1", "2", "3"]);
  await page.waitForTimeout(400);
  expect(
    Math.abs((await scroller.evaluate((el) => el.scrollTop)) - top),
  ).toBeLessThan(2);
  await page.screenshot({
    path: ".local-data/feedback-014c-review/scroll-stable.png",
  });
  await page.getByRole("button", { name: "回到最新" }).click();
  await expect
    .poll(async () =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThan(2);
  expect(errors).toEqual([]);
});
