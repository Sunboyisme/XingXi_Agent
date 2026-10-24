import { Hint } from "./common";
import "@/styles/detail-view.css";
import { useNativeDrop, nativeFile } from "@/lib/nativeDrop";
import { isTauri } from "@tauri-apps/api/core";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Code2,
  FileArchive,
  FileText,
  Files,
  FolderOpen,
  Loader2,
  Puzzle,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import { api, fetchApi, type Skill, type SkillPreview } from "@/lib/api";
import { Button } from "./ui/button";
import { ConfirmDelete, ErrorNotice, Markdown } from "./common";
import {
  droppedSkillFiles,
  selectedSkillFiles,
  type SkillUpload,
} from "@/lib/skillFiles";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";

function SkillSection({
  title,
  hint,
  icon: Icon,
  children,
}: {
  title: string;
  hint: string;
  icon: typeof FileText;
  children: ReactNode;
}) {
  return (
    <section className="skill-section plain-section">
      <header>
        <span className="skill-disclosure-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        <span className="skill-disclosure-copy">
          <strong>{title}</strong>
          <small>{hint}</small>
        </span>
      </header>
      <div className="skill-disclosure-body">{children}</div>
    </section>
  );
}

export function SkillsSettings({ onRuntimes }: { onRuntimes: () => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [detail, setDetail] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const nativeTarget = useRef<HTMLElement>(null);
  useNativeDrop(
    nativeTarget,
    (files) =>
      inspect(
        files.map((file) => ({
          file: nativeFile(file),
          path: file.relative_path,
        })),
      ),
    setError,
    true,
    busy,
  );
  const importBusy = useRef(false);
  const zip = useRef<HTMLInputElement>(null),
    directory = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setSkills(await api<Skill[]>("/skills"));
  }, []);
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  async function inspect(input: SkillUpload[] | Promise<SkillUpload[]>) {
    if (busy || importBusy.current) return;
    importBusy.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const files = await input;
      if (!files.length)
        throw new Error("请选择包含 SKILL.md 的技能文件夹或 ZIP");
      if (
        files.length > 500 ||
        files.reduce((total, item) => total + item.file.size, 0) >
          20 * 1024 * 1024
      )
        throw new Error("技能包最多 500 个文件、20 MB");
      const body = new FormData();
      for (const { file, path } of files) body.append("files", file, path);
      setPreview(
        await (
          await fetchApi("/skills/preview", { method: "POST", body })
        ).json(),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      importBusy.current = false;
      setBusy(false);
      if (zip.current) zip.current.value = "";
      if (directory.current) directory.current.value = "";
    }
  }
  async function patch(
    skill: Skill,
    value: { enabled?: boolean; scripts_allowed?: boolean },
  ) {
    setBusy(true);
    setError("");
    const optimistic = { ...skill, ...value };
    setSkills((rows) =>
      rows.map((row) => (row.id === skill.id ? optimistic : row)),
    );
    setDetail((current) => (current?.id === skill.id ? optimistic : current));
    try {
      const next = await api<Skill>(`/skills/${skill.id}`, "PATCH", value);
      setSkills((rows) => rows.map((row) => (row.id === next.id ? next : row)));
      setDetail((current) => (current?.id === next.id ? next : current));
    } catch (e) {
      setSkills((rows) =>
        rows.map((row) => (row.id === skill.id ? skill : row)),
      );
      setDetail((current) => (current?.id === skill.id ? skill : current));
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      ref={nativeTarget}
      className={`skills-settings ${dragging ? "skills-dragging" : ""}`}
      onDragEnter={(event) => {
        if (isTauri()) return;
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          dragDepth.current++;
          if (!busy) setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (isTauri()) return;
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = busy ? "none" : "copy";
        }
      }}
      onDragLeave={(event) => {
        if (isTauri()) return;
        if (
          event.dataTransfer.types.includes("Files") &&
          --dragDepth.current <= 0
        ) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (isTauri()) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!busy && !importBusy.current)
          void inspect(droppedSkillFiles(event.dataTransfer));
      }}
    >
      <div className="skills-heading">
        <div>
          <h2>
            <Puzzle size={21} />
            让小汐多一点本领
          </h2>
          <p>导入你信任的技能，按需要启用。</p>
        </div>
        <div className="row-actions">
          <Button variant="ghost" disabled={busy} onClick={onRuntimes}>
            <Code2 size={15} />
            运行环境
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => directory.current?.click()}
          >
            <FolderOpen size={15} />
            导入文件夹
          </Button>
          <Button disabled={busy} onClick={() => zip.current?.click()}>
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <FileArchive size={15} />
            )}
            导入 ZIP
          </Button>
        </div>
      </div>
      <input
        hidden
        ref={zip}
        type="file"
        accept=".zip"
        aria-label="选择技能 ZIP"
        onChange={(e) => {
          if (e.target.files?.length)
            void inspect(selectedSkillFiles(e.target.files));
        }}
      />
      <input
        hidden
        ref={(el) => {
          directory.current = el;
          el?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        aria-label="选择技能文件夹"
        onChange={(e) => {
          if (e.target.files?.length)
            void inspect(selectedSkillFiles(e.target.files));
        }}
      />
      {error && <ErrorNotice message={error} />}
      {notice && (
        <p role="status" className="skills-notice">
          {notice}
        </p>
      )}
      <div
        className="skill-dropzone"
        aria-label="技能拖入区域"
        aria-busy={busy}
      >
        {busy ? <Loader2 size={25} className="spin" /> : <Upload size={25} />}
        <strong>{dragging ? "松开以预览技能" : "拖入技能文件夹或 ZIP"}</strong>
        <span>先预览，再确认导入 · 最多 500 个文件 / 20 MB</span>
      </div>
      {!skills.length && (
        <div className="skills-empty">
          <Puzzle size={34} />
          <h3>把擅长的事，交给合适的技能</h3>
          <p>选择包含 SKILL.md 的文件夹或 ZIP。导入只保存文件，不运行脚本。</p>
        </div>
      )}
      <div className="skill-cards">
        {skills.map((skill) => (
          <article className="skill-card" key={skill.id}>
            <div className="skill-card-heading">
              <button onClick={() => setDetail(skill)}>
                <Puzzle size={18} />
                <strong>{skill.name}</strong>
              </button>
              <label className="plan-check">
                <input
                  type="checkbox"
                  aria-label={`启用技能 ${skill.name}`}
                  checked={skill.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    void patch(skill, { enabled: e.target.checked })
                  }
                />
                {skill.enabled ? "已启用" : "未启用"}
              </label>
            </div>
            <Hint label={skill.description}>
              <p className="skill-card-description">{skill.description}</p>
            </Hint>
            <div className="skill-card-footer">
              <span>
                {skill.name === "text-notes" && (
                  <span className="skill-builtin-label">示例技能 · </span>
                )}
                {skill.files.length} 个文件 ·{" "}
                {!skill.files.some((file) => file.startsWith("scripts/"))
                  ? "说明型技能"
                  : skill.scripts_allowed
                    ? "脚本已授权"
                    : "脚本未授权"}
              </span>
              <Button
                className="skill-card-open"
                size="sm"
                variant="ghost"
                onClick={() => setDetail(skill)}
              >
                查看技能
              </Button>
            </div>
          </article>
        ))}
      </div>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(v) => {
          if (!v && !busy) setPreview(null);
        }}
      >
        <DialogContent className="skill-detail-dialog">
          <DialogHeader>
            <DialogTitle>
              {preview?.existing_id ? "替换已有技能" : "导入这个技能"}
            </DialogTitle>
            <DialogDescription>
              {preview?.name} · {preview?.description}
            </DialogDescription>
          </DialogHeader>
          {error && <ErrorNotice message={error} />}
          {preview && (
            <>
              <SkillSection
                title="技能说明"
                hint="导入前检查这个技能会做什么"
                icon={FileText}
              >
                <Markdown>{preview.body}</Markdown>
              </SkillSection>
              <SkillSection
                title="文件清单"
                hint={`包含 ${preview.files.length} 个文件，可逐项核对`}
                icon={Files}
              >
                <ul>
                  {preview.files.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </SkillSection>
              <p className="skill-permission-note">
                {preview.existing_id
                  ? "替换内容有变化时，将关闭此技能并撤销脚本授权。"
                  : "导入后默认停用，脚本需要另行授权。"}
              </p>
            </>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              取消
            </Button>
            <Button
              disabled={busy}
              onClick={async () => {
                if (!preview) return;
                setBusy(true);
                setError("");
                try {
                  await api("/skills/import", "POST", {
                    preview_id: preview.preview_id,
                    replace_id: preview.existing_id || undefined,
                  });
                  setPreview(null);
                  await load();
                  setNotice("技能已保存，可以按需要启用");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? "正在保存…"
                : preview?.existing_id
                  ? "替换技能"
                  : "确认导入"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(detail)}
        onOpenChange={(v) => {
          if (!v) setDetail(null);
        }}
      >
        <DialogContent className="skill-detail-dialog">
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
            <DialogDescription>{detail?.description}</DialogDescription>
          </DialogHeader>
          {error && <ErrorNotice message={error} />}
          {detail && (
            <>
              <label className="plan-check">
                <input
                  type="checkbox"
                  checked={detail.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    void patch(detail, { enabled: e.target.checked })
                  }
                />
                启用此技能
              </label>
              {detail.files.some((file) => file.startsWith("scripts/")) ? (
                <div className="skill-permission">
                  <label className="plan-check">
                    <input
                      type="checkbox"
                      checked={detail.scripts_allowed}
                      disabled={busy}
                      onChange={(e) =>
                        void patch(detail, {
                          scripts_allowed: e.target.checked,
                        })
                      }
                    />
                    允许小汐自动运行此技能的脚本
                  </label>
                  <p>
                    脚本以你的 Windows
                    用户权限运行，可以访问当前用户可访问的文件与网络。任务工作目录不是安全沙箱。授权后按聊天任务执行；关闭此项会停止运行中的脚本。
                  </p>
                </div>
              ) : (
                <p className="skill-permission-note">
                  这个技能只包含说明与参考资料，没有可执行脚本。
                </p>
              )}
              <SkillSection
                title="技能正文"
                hint="查看完整说明、使用条件与参考资料"
                icon={FileText}
              >
                <Markdown>{detail.body}</Markdown>
              </SkillSection>
              <SkillSection
                title="文件清单"
                hint={`包含 ${detail.files.length} 个文件，可逐项核对`}
                icon={Files}
              >
                <ul>
                  {detail.files.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </SkillSection>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDeleting(detail)}>
                  <Trash2 size={15} />
                  删除
                </Button>
                {detail.files.some((file) => file.startsWith("scripts/")) && (
                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        await api(`/skills/${detail.id}/stop`, "POST");
                        setNotice("已请求停止此技能的脚本");
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <Square size={14} />
                    停止脚本
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDelete
        open={Boolean(deleting)}
        title="删除这个技能？"
        description="移除技能包和授权，已经生成的聊天产物会保留。"
        label="删除技能"
        error={error}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api(`/skills/${deleting.id}`, "DELETE");
            setDeleting(null);
            setDetail(null);
            await load();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
    </section>
  );
}
