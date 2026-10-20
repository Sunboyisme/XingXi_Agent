import { expect, test } from "vitest";
import { lunarDate } from "./lunarCalendar";
import { holidayOn } from "./holidays";

// Dates cross-checked with Hong Kong Observatory's 2026 conversion table.
test("lunar dates include new year, first days, leap months and solar terms", () => {
  expect(lunarDate("2026-02-17")).toMatchObject({ label: "正月", term: "" });
  expect(lunarDate("2026-02-17").title).toContain("正月初一");
  expect(lunarDate("2025-07-25").label).toBe("闰六月");
  expect(lunarDate("2026-10-08")).toMatchObject({
    label: "廿八",
    term: "寒露",
  });
  expect(lunarDate("2026-10-23")).toMatchObject({
    label: "十四",
    term: "霜降",
  });
  expect(lunarDate("2026-12-22").term).toBe("冬至");
});

test("festivals work beyond the published leave schedule and New Year's Eve can be day 29", () => {
  expect(lunarDate("2027-02-05")).toMatchObject({
    label: "廿九",
    festival: "除夕",
  });
  expect(lunarDate("2027-02-05").title).toContain("腊月廿九 · 除夕");
  expect(lunarDate("2027-02-06").festival).toBe("春节");
  expect(lunarDate("2024-02-09")).toMatchObject({
    label: "三十",
    festival: "除夕",
  });
  expect(lunarDate("2027-06-09").festival).toBe("端午节");
  expect(lunarDate("2027-09-15").festival).toBe("中秋节");
  expect(lunarDate("2027-01-01").festival).toMatch(/元旦/);
  expect(lunarDate("2027-10-01").festival).toBe("国庆节");
  expect(holidayOn("2027-02-05")).toBeUndefined();
  expect(holidayOn("2026-10-10")?.kind).toBe("work");
});
