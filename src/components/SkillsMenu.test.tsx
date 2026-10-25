import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DropdownMenu } from "radix-ui";
import { SkillsMenu } from "./SkillsMenu";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("skill menu lists imported skills and persists an enabled switch", async () => {
  apiMock.mockImplementation(async (path: string, method?: string) => {
    if (path === "/skills" && !method)
      return [
        {
          id: "notes",
          name: "笔记整理",
          description: "把零散内容整理成笔记",
          body: "",
          files: [],
          enabled: false,
          scripts_allowed: false,
        },
      ];
    if (path === "/skills/notes" && method === "PATCH")
      return {
        id: "notes",
        name: "笔记整理",
        description: "把零散内容整理成笔记",
        body: "",
        files: [],
        enabled: true,
        scripts_allowed: false,
      };
    return [];
  });
  const onSettings = vi.fn();
  render(
    <DropdownMenu.Root defaultOpen>
      <DropdownMenu.Trigger>添加</DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <SkillsMenu onSettings={onSettings} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>,
  );
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "技能" }), {
    key: "ArrowRight",
  });
  const skill = await screen.findByRole("menuitemcheckbox", {
    name: /笔记整理/,
  });
  fireEvent.click(skill);
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith("/skills/notes", "PATCH", {
      enabled: true,
    }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "管理技能" }));
  expect(onSettings).toHaveBeenCalledOnce();
});
