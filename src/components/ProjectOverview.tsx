import { useEffect, useState } from "react";
import {
  Folder,
  Library,
  MessageCircle,
  Pin,
  Plus,
  Settings2,
  Upload,
} from "lucide-react";
import { api, type Conversation, type Project } from "@/lib/api";
import { Button } from "./ui/button";
import { FileCard } from "./OfficeFiles";
import { Picture } from "./ImageAttachments";

type Material = {
  id: string;
  file_id: string;
  name: string;
  image: boolean;
  file_status: string;
  error: string;
};

export function ProjectOverview({
  project,
  conversations,
  revision,
  onNew,
  onOpen,
  onLibrary,
  onSettings,
}: {
  project: Project;
  conversations: Conversation[];
  revision: number;
  onNew: () => void;
  onOpen: (conversation: Conversation) => void;
  onLibrary: () => void;
  onSettings: () => void;
}) {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    let timer = 0;
    setLoading(true);
    setError("");
    setMaterials([]);
    async function load() {
      try {
        const values = await api<Material[]>(
          `/projects/${project.id}/materials`,
        );
        if (!live) return;
        setMaterials(values);
        setError("");
        if (
          values.some((item) =>
            ["queued", "parsing"].includes(item.file_status),
          )
        ) {
          timer = window.setTimeout(() => void load(), 1500);
        }
      } catch (cause) {
        if (live) setError((cause as Error).message);
      } finally {
        if (live) setLoading(false);
      }
    }
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [project.id, revision]);
  const chats = conversations
    .filter((item) => item.project_id === project.id)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return (
    <div className="project-overview">
      <header className="project-overview-header">
        <div>
          <p className="project-eyebrow">
            <Folder size={16} />
            项目
          </p>
          <h1>{project.name}</h1>
          <p className="project-overview-description">
            {project.instructions || "在这里集中管理项目对话与共享资料。"}
          </p>
        </div>
        <div className="project-overview-actions">
          <Button onClick={onNew}>
            <Plus size={16} />
            新建对话
          </Button>
          <Button variant="outline" onClick={onLibrary}>
            <Library size={16} />
            资料库{!loading && !error ? ` (${materials.length})` : ""}
          </Button>
          <Button variant="ghost" onClick={onSettings}>
            <Settings2 size={16} />
            项目设置
          </Button>
        </div>
      </header>
      <div className="project-overview-columns">
        <section className="project-overview-chats">
          <h2>
            项目对话 <small>{chats.length}</small>
          </h2>
          {chats.map((item) => (
            <button
              className="project-overview-chat"
              key={item.id}
              onClick={() => onOpen(item)}
            >
              {item.pinned_at ? (
                <Pin size={17} aria-label="已置顶" />
              ) : (
                <MessageCircle size={17} />
              )}
              <strong>{item.title}</strong>
              <time dateTime={item.updated_at}>
                {new Date(item.updated_at).toLocaleDateString("zh-CN")}
              </time>
            </button>
          ))}
          {!chats.length && (
            <div className="project-overview-empty">
              <p>项目里还没有对话。</p>
              <Button variant="outline" onClick={onNew}>
                <Plus size={15} />
                开始第一段对话
              </Button>
            </div>
          )}
        </section>
        <section className="project-overview-materials">
          <div className="project-overview-section-heading">
            <h2>最近资料</h2>
            <Button size="sm" variant="ghost" onClick={onLibrary}>
              查看全部
            </Button>
          </div>
          {error && <p role="alert">{error}</p>}
          {loading && <p role="status">正在读取项目资料…</p>}
          {materials.slice(0, 4).map((item) => (
            <article key={item.id}>
              {item.image ? (
                <div className="project-overview-image">
                  <Picture id={item.file_id} name={item.name} />
                  <span>{item.name}</span>
                </div>
              ) : (
                <FileCard file={{ id: item.file_id, name: item.name }} upload />
              )}
              {item.file_status !== "ready" && (
                <small>
                  {item.file_status === "partial"
                    ? "部分可读"
                    : item.file_status === "failed"
                      ? item.error || "解析失败"
                      : "正在解析…"}
                </small>
              )}
            </article>
          ))}
          {!loading && !error && !materials.length && (
            <p className="muted">上传资料后，同项目的对话都能按需读取。</p>
          )}
          <Button variant="outline" onClick={onLibrary}>
            <Upload size={15} />
            上传资料
          </Button>
        </section>
      </div>
    </div>
  );
}
