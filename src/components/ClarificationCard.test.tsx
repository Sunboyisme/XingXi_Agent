import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Clarification } from "@/lib/api";
import { ClarificationCard } from "./ClarificationCard";

afterEach(cleanup);

const question: Clarification = {
  request_id: "request-1",
  source_message_id: "message-1",
  state: "pending",
  questions: [
    {
      id: "q1",
      question: "希望哪天开始？",
      multiple: false,
      options: [
        { id: "o1", label: "11月2日", description: "" },
        { id: "o2", label: "12月2日", description: "" },
      ],
    },
  ],
};

test("no answer is preselected and the final option accepts custom text", async () => {
  const send = vi.fn().mockResolvedValue(true);
  render(<ClarificationCard request={question} onAnswer={send} />);
  expect(
    screen
      .getAllByRole("radio")
      .every((element) => !(element as HTMLInputElement).checked),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("请选择");
  const options = screen.getAllByRole("radio");
  expect(options[options.length - 1].getAttribute("value")).toBe("other");
  fireEvent.click(screen.getByRole("radio", { name: "其他，我来填写" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "希望哪天开始？：自己的回答" }),
    { target: { value: "  明年1月2日  " } },
  );
  fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith({
      request_id: "request-1",
      source_message_id: "message-1",
      answers: [
        { question_id: "q1", option_ids: ["other"], custom_text: "明年1月2日" },
      ],
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("已回答"),
  );
});

test("failed submission retains selections and custom text", async () => {
  render(
    <ClarificationCard
      request={question}
      onAnswer={vi.fn().mockResolvedValue(false)}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "其他，我来填写" }));
  const input = screen.getByRole("textbox", {
    name: "希望哪天开始？：自己的回答",
  });
  fireEvent.change(input, { target: { value: "稍后确定" } });
  fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("已保留"),
  );
  expect((input as HTMLTextAreaElement).value).toBe("稍后确定");
  expect(
    (screen.getByRole("radio", { name: "其他，我来填写" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

test("multi-select accepts several choices and an already answered card cannot submit again", async () => {
  const send = vi.fn().mockResolvedValue(true);
  const multiple = {
    ...question,
    questions: question.questions.map((item) => ({ ...item, multiple: true })),
  };
  const { unmount } = render(
    <ClarificationCard request={multiple} onAnswer={send} />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "11月2日" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "12月2日" }));
  fireEvent.click(screen.getByRole("button", { name: "提交并继续" }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0][0].answers[0].option_ids).toEqual(["o1", "o2"]);
  unmount();
  render(
    <ClarificationCard
      request={{ ...question, state: "answered" }}
      onAnswer={send}
    />,
  );
  expect(screen.queryByRole("button", { name: "提交并继续" })).toBeNull();
  expect(
    (
      screen.getByRole("group", {
        name: "希望哪天开始？",
      }) as HTMLFieldSetElement
    ).disabled,
  ).toBe(true);
});
