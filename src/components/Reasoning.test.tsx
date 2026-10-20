import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { Reasoning } from "./Reasoning";
afterEach(cleanup);

test("reasoning opens during generation, respects a manual collapse and folds on completion", () => {
  const view = render(<Reasoning text="真实返回的片段" active />);
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button"));
  view.rerender(<Reasoning text="真实返回的片段，继续增加" active />);
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
    "false",
  );
  fireEvent.click(screen.getByRole("button"));
  view.rerender(<Reasoning text="真实返回的片段，继续增加" />);
  expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
    "false",
  );
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByText("真实返回的片段，继续增加")).toBeTruthy();
});

test("missing reasoning has no placeholder; interrupted reasoning remains readable", () => {
  const view = render(<Reasoning text="" active />);
  expect(screen.queryByRole("region")).toBeNull();
  view.rerender(<Reasoning text="未完成片段" incomplete />);
  fireEvent.click(screen.getByRole("button", { name: "这个想法还没说完" }));
  expect(screen.getByText("未完成片段")).toBeTruthy();
});
