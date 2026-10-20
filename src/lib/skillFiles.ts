export type SkillUpload = { file: File; path: string };

export function selectedSkillFiles(files: FileList | null): SkillUpload[] {
  return Array.from(files || []).map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
  }));
}

// Capture entries before yielding: the browser clears DataTransfer after the drop event.
export async function droppedSkillFiles(
  transfer: DataTransfer,
): Promise<SkillUpload[]> {
  const entries = Array.from(transfer.items || [])
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.());
  const fallback = selectedSkillFiles(transfer.files);
  if (!entries.length || entries.some((e) => !e)) return fallback;
  const files: SkillUpload[] = [];
  let size = 0;
  async function visit(
    entry: FileSystemEntry,
    parent = "",
    depth = 0,
  ): Promise<void> {
    if (depth > 20) throw new Error("技能目录层级过深，请使用精简的技能文件夹");
    const path = parent + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      size += file.size;
      files.push({ file, path });
      if (files.length > 500 || size > 20 * 1024 * 1024)
        throw new Error("技能包最多 500 个文件、20 MB");
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch) await visit(child, path + "/", depth + 1);
      }
    }
  }
  for (const entry of entries) await visit(entry!);
  return files;
}
