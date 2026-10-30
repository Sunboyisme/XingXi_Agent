import { beforeEach, expect, test } from "vitest";
import { DesktopTaskInbox, markDesktopTaskRead } from "./desktopTaskInbox";
import { PetActivities, presentDesktopTask } from "./avatarActivity";

beforeEach(() => localStorage.clear());
const task = (id: string, kind?: string) =>
  presentDesktopTask({
    runId: id,
    runStatus: "completed",
    kind,
    source: "poll",
    updatedAt: "2026-10-30T01:00:00Z",
  });
test("selection actions never become unread work or avatar activity", () => {
  const inbox = new DesktopTaskInbox();
  expect(
    inbox
      .accept([task("chat", "chat"), task("selection", "desktop_action")])
      .map((value) => value.runId),
  ).toEqual(["chat"]);
  const activities = new PetActivities();
  expect(
    activities.accept([
      { ...task("selection", "desktop_action"), runStatus: "running" },
    ]).active,
  ).toBe(false);
  expect(activities.activeIds()).toEqual([]);
  activities.accept([{ ...task("old-selection"), runStatus: "running" }]);
  const cleared = activities.accept([task("old-selection", "desktop_action")]);
  expect(cleared.active).toBe(false);
  expect(cleared.current).toBeUndefined();
});
test("old cached actions are removed when kind is learned, preserving unread chat", () => {
  localStorage.setItem(
    "xiaoxi-desktop-task-inbox-v1",
    JSON.stringify([task("old-selection"), task("chat", "chat")]),
  );
  const inbox = new DesktopTaskInbox();
  expect(inbox.list()).toHaveLength(2);
  expect(
    inbox
      .accept([task("old-selection", "desktop_action")])
      .map((value) => value.runId),
  ).toEqual(["chat"]);
  expect(new DesktopTaskInbox().list().map((value) => value.runId)).toEqual([
    "chat",
  ]);
});
test("reading one card persists across polling and reload without hiding another card", () => {
  const inbox = new DesktopTaskInbox();
  inbox.accept([task("first", "chat"), task("second", "chat")]);
  markDesktopTaskRead({ runId: "first" });
  expect(inbox.list().map((value) => value.runId)).toEqual(["second"]);
  expect(
    inbox
      .accept([task("first", "chat"), task("second", "chat")])
      .map((value) => value.runId),
  ).toEqual(["second"]);
  expect(new DesktopTaskInbox().list().map((value) => value.runId)).toEqual([
    "second",
  ]);
});
