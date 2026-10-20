import { expect, type Page } from "@playwright/test";

export async function selectCalendarDate(
  page: Page,
  label: string,
  day: string,
  time?: string,
) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const popup = page.locator(".datetime-popover");
  const targetMonth = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7));
  for (let i = 0; i < 36; i++) {
    const text = await popup
      .locator(".calendar-heading > strong")
      .textContent();
    const [, year, month] = text!.match(/(\d+)年(\d+)月/)!;
    const currentMonth = Number(year) * 12 + Number(month);
    if (currentMonth === targetMonth) break;
    await popup
      .getByRole("button", {
        name: currentMonth < targetMonth ? "下个月" : "上个月",
        exact: true,
      })
      .click();
  }
  await popup.locator(`[data-date="${day}"]`).click();
  if (time) {
    await popup.getByLabel("小时").fill(time.slice(0, 2));
    await popup.getByLabel("分钟").fill(time.slice(3, 5));
  } else {
    await expect(popup.locator(".calendar-time")).toHaveCount(0);
  }
  await popup.getByRole("button", { name: "确定", exact: true }).click();
}
