import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "./alert-dialog";

afterEach(cleanup);

function ControlledDialog({
  alert,
  customFocus = false,
}: {
  alert: boolean;
  customFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const Root = alert ? AlertDialog : Dialog;
  const Content = alert ? AlertDialogContent : DialogContent;
  const Title = alert ? AlertDialogTitle : DialogTitle;
  const Description = alert ? AlertDialogDescription : DialogDescription;
  const Close = alert ? AlertDialogCancel : "button";
  return (
    <>
      <button onClick={() => setOpen(true)}>打开测试弹窗</button>
      <button id="next-action">下一项操作</button>
      <Root open={open} onOpenChange={setOpen}>
        <Content
          onCloseAutoFocus={
            customFocus
              ? (event) => {
                  event.preventDefault();
                  document.getElementById("next-action")?.focus();
                }
              : undefined
          }
        >
          <Title>测试弹窗</Title>
          <Description>检查无 Trigger 的受控弹窗。</Description>
          <Close onClick={() => setOpen(false)}>关闭测试弹窗</Close>
        </Content>
      </Root>
    </>
  );
}

test.each([false, true])(
  "controlled dialog restores its external opener (alert=%s)",
  async (alert) => {
    render(<ControlledDialog alert={alert} />);
    const opener = screen.getByRole("button", { name: "打开测试弹窗" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole(alert ? "alertdialog" : "dialog");
    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭测试弹窗" }));
    await waitFor(() => expect(opener).toHaveFocus());
  },
);

test.each([false, true])(
  "controlled dialog respects caller focus handling (alert=%s)",
  async (alert) => {
    render(<ControlledDialog alert={alert} customFocus />);
    const opener = screen.getByRole("button", { name: "打开测试弹窗" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole(alert ? "alertdialog" : "dialog");
    fireEvent.click(screen.getByRole("button", { name: "关闭测试弹窗" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "下一项操作" })).toHaveFocus(),
    );
  },
);
