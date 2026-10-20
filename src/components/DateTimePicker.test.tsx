import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DateTimePicker } from "./DateTimePicker";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("date and time are drafts until confirmed and include the selected month", async () => {
  const change = vi.fn();
  render(
    <DateTimePicker id="date" value="2026-10-17T22:00" onChange={change} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "时间（北京时间）" }));
  fireEvent.click(
    screen.getByRole("button", { name: "2026年10月19日 星期一" }),
  );
  fireEvent.change(screen.getByLabelText("小时"), { target: { value: "08" } });
  fireEvent.change(screen.getByLabelText("分钟"), { target: { value: "30" } });
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(change).toHaveBeenCalledWith("2026-10-19T08:30");
  await waitFor(() => expect(screen.queryByLabelText("小时")).toBeNull());
});

test("month navigation clamps to leap day and rejects invalid times", () => {
  const change = vi.fn();
  render(
    <DateTimePicker id="date" value="2028-01-31T10:15" onChange={change} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "时间（北京时间）" }));
  fireEvent.click(screen.getByRole("button", { name: "下个月" }));
  expect(
    screen
      .getByRole("button", { name: "2028年2月29日 星期二" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.change(screen.getByLabelText("小时"), { target: { value: "24" } });
  expect(
    (screen.getByRole("button", { name: "确定" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("小时"), { target: { value: "23" } });
  fireEvent.change(screen.getByLabelText("分钟"), { target: { value: "60" } });
  expect(
    (screen.getByRole("button", { name: "确定" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("分钟"), { target: { value: "59" } });
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(change).toHaveBeenCalledWith("2028-02-29T23:59");
});

test("keyboard date navigation crosses years and Escape discards changes", async () => {
  const change = vi.fn();
  render(
    <DateTimePicker id="date" value="2027-01-01T09:00" onChange={change} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "时间（北京时间）" }));
  fireEvent.keyDown(
    screen.getByRole("button", { name: "2027年1月1日 星期五" }),
    { key: "ArrowLeft" },
  );
  const selected = screen.getByRole("button", {
    name: "2026年12月31日 星期四",
  });
  await waitFor(() => expect(document.activeElement).toBe(selected));
  fireEvent.keyDown(selected, { key: "Escape" });
  await waitFor(() => expect(screen.queryByLabelText("小时")).toBeNull());
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "时间（北京时间）" }));
  expect(
    screen
      .getByRole("button", { name: "2027年1月1日 星期五" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

test("date-only mode shares the calendar but omits all time controls", () => {
  const change = vi.fn();
  render(
    <DateTimePicker
      id="day"
      value="2026-10-20"
      dateOnly
      label="开始日期"
      onChange={change}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "开始日期" }));
  expect(screen.queryByLabelText("小时")).toBeNull();
  expect(screen.queryByLabelText("分钟")).toBeNull();
  expect(screen.queryByRole("button", { name: "09:00" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "2026年10月21日 星期三" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(change).toHaveBeenCalledWith("2026-10-21");
});
