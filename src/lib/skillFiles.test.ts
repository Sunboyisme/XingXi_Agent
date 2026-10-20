import { expect, test } from "vitest";
import { droppedSkillFiles } from "./skillFiles";

test("folder drops read every directory batch and preserve reference paths", async () => {
  const file = (name: string) => ({
    isFile: true,
    name,
    file: (done: (f: File) => void) => done(new File(["test"], name)),
  });
  const folder = (name: string, batches: unknown[][]) => ({
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (done: (entries: unknown[]) => void) =>
        done(batches.shift() || []),
    }),
  });
  const root = folder("my-skill", [
    [file("SKILL.md")],
    [folder("references", [[file("guide.md")]])],
  ]);
  const result = await droppedSkillFiles({
    items: [{ kind: "file", webkitGetAsEntry: () => root }],
    files: [],
  } as unknown as DataTransfer);
  expect(result.map((f) => f.path)).toEqual([
    "my-skill/SKILL.md",
    "my-skill/references/guide.md",
  ]);
});

test("ZIP drops fall back to files when entry API is unavailable", async () => {
  const file = new File(["zip"], "skill.zip");
  const result = await droppedSkillFiles({
    items: [],
    files: [file],
  } as unknown as DataTransfer);
  expect(result).toEqual([{ file, path: "skill.zip" }]);
});
