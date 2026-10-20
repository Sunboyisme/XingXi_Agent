// Inclusive leave dates and make-up workdays, from the State Council notices.
// Unpublished years deliberately have no inferred work/rest adjustments.
// 2025: https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm
// 2026: https://www.gov.cn/zhengce/content/202511/content_7047090.htm
type Holiday = { name: string; kind: "off" | "work" };
const dates = new Map<string, Holiday>();
function add(
  year: number,
  name: string,
  first: string,
  last: string,
  work: string[] = [],
) {
  for (
    let day = new Date(`${year}-${first}T00:00:00Z`);
    day.toISOString().slice(5, 10) <= last && day.getUTCFullYear() === year;
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    dates.set(day.toISOString().slice(0, 10), { name, kind: "off" });
  }
  for (const day of work)
    dates.set(`${year}-${day}`, { name: `${name}调休`, kind: "work" });
}
add(2025, "元旦", "01-01", "01-01");
add(2025, "春节", "01-28", "02-04", ["01-26", "02-08"]);
add(2025, "清明", "04-04", "04-06");
add(2025, "劳动节", "05-01", "05-05", ["04-27"]);
add(2025, "端午", "05-31", "06-02");
add(2025, "国庆·中秋", "10-01", "10-08", ["09-28", "10-11"]);
add(2026, "元旦", "01-01", "01-03", ["01-04"]);
add(2026, "春节", "02-15", "02-23", ["02-14", "02-28"]);
add(2026, "清明", "04-04", "04-06");
add(2026, "劳动节", "05-01", "05-05", ["05-09"]);
add(2026, "端午", "06-19", "06-21");
add(2026, "中秋", "09-25", "09-27");
add(2026, "国庆", "10-01", "10-07", ["09-20", "10-10"]);
export const holidayOn = (day: string) => dates.get(day);
