import { Solar } from "lunar-typescript";

const lunarFestivals = new Set([
  "除夕",
  "春节",
  "元宵节",
  "端午节",
  "七夕节",
  "中秋节",
  "重阳节",
  "腊八节",
]);
const solarFestivals = new Set(["元旦节", "元旦", "劳动节", "国庆节"]);

// Chinese calendar dates/terms use the civil date in UTC+8, independent of the OS timezone.
export function lunarDate(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  const solar = Solar.fromYmd(year, month, date);
  const lunar = solar.getLunar();
  const monthName = `${lunar.getMonthInChinese()}月`;
  const dayName = lunar.getDayInChinese();
  const term = lunar.getJieQi();
  // Festival dates are independent of annual leave/make-up-work notices.
  // In particular, New Year's Eve is the last lunar day, including 29-day months.
  const festival = [
    ...lunar.getFestivals().filter((name) => lunarFestivals.has(name)),
    ...solar.getFestivals().filter((name) => solarFestivals.has(name)),
  ].join("·");
  return {
    label: lunar.getDay() === 1 ? monthName : dayName,
    term,
    festival,
    title: `${day} · 农历${lunar.getYear()}年${monthName}${dayName}${festival ? ` · ${festival}` : ""}${term ? ` · ${term}` : ""}`,
  };
}
