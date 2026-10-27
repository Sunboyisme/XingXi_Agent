import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MemorySavedNotice } from "./MemoryFeedback";

vi.mock("@/lib/api", () => ({ api: vi.fn(async () => ({})) }));

afterEach(() => vi.useRealTimers());

test("leaving with the pointer does not dismiss a keyboard-focused memory notice", () => {
  vi.useFakeTimers();
  const close = vi.fn();
  const { container } = render(<MemorySavedNotice
    notice={{ change_id: "change", content: "偏好", action: "created" }}
    refresh={async () => {}} onClose={close} />);
  const notice = container.querySelector(".memory-saved-notice")!;
  const undo = screen.getByRole("button", { name: "撤销" });
  fireEvent.focus(undo);
  fireEvent.pointerEnter(notice);
  fireEvent.pointerLeave(notice);
  act(() => vi.advanceTimersByTime(9000));
  expect(close).not.toHaveBeenCalled();
  fireEvent.blur(undo, { relatedTarget: document.body });
  act(() => vi.advanceTimersByTime(8000));
  expect(close).toHaveBeenCalledTimes(1);
});
