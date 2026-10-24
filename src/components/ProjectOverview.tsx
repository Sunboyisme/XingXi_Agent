import { useEffect, useState } from "react";
import { ArrowLeft, Folder, Library, MessageCircle, Pin, Plus, Settings2, Upload } from "lucide-react";
import { api, type Conversation, type Project } from "@/lib/api";
import { Button } from "./ui/button";
import { FileCard } from "./OfficeFiles";
import { Picture } from "./ImageAttachments";
import { materialStatus, type ProjectMaterial } from "./ProjectManagement";
import "@/styles/projects-workspace.css";

export function ProjectOverview({ project, conversations, revision, onNew, onOpen, onLibrary, onSettings, onBack }: {
  project: Project; conversations: Conversation[]; revision: number;
  onNew: () => void; onOpen: (conversation: Conversation) => void;
  onLibrary: () => void; onSettings: () => void; onBack?: () => void;
}) {
  const [materials, setMaterials] = useState<ProjectMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"chats" | "materials">("chats");
  useEffect(() => {
    let live = true;
    let timer = 0;
    setLoading(true); setError(""); setMaterials([]);
    async function load() {
      try {
        const values = await api<ProjectMaterial[]>(`/projects/${project.id}/materials`);
        if (!live) return;
        setMaterials(values); setError("");
        if (values.some((item) => ["queued", "parsing"].includes(item.file_status))) timer = window.setTimeout(() => void load(), 1500);
      } catch (cause) { if (live) setError((cause as Error).message); }
      finally { if (live) setLoading(false); }
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [project.id, revision]);
  const chats = conversations.filter((item) => item.project_id === project.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return <div className="project-overview project-overview-fixed">
    <header className="project-overview-header">
      <div className="project-overview-intro">
        <p className="project-eyebrow">{onBack ? <button className="project-back" onClick={onBack}><ArrowLeft size={15} />全部项目</button> : <><Folder size={16} />项目</>}</p>
        <h1 title={project.name}>{project.name}</h1>
        <details className="project-description-details"><summary title={project.instructions || "在这里集中管理项目对话与共享资料。"}>{project.instructions || "在这里集中管理项目对话与共享资料。"}</summary><p>{project.instructions || "在这里集中管理项目对话与共享资料。"}</p></details>
        {project.workspace_path && <p className="project-workspace-path" title={project.workspace_path}><Folder size={14} /><span>{project.workspace_path}</span><small>只读</small></p>}
      </div>
      <div className="project-overview-actions">
        <Button onClick={onNew}><Plus size={16} />新建对话</Button>
        <Button variant="outline" onClick={onLibrary}><Library size={16} />资料库{!loading && !error ? ` (${materials.length})` : ""}</Button>
        <Button variant="ghost" onClick={onSettings}><Settings2 size={16} />项目设置</Button>
      </div>
    </header>
    <div className="project-overview-tabs" role="tablist" aria-label="项目内容">
      <button role="tab" id="project-chats-tab" aria-selected={tab === "chats"} aria-controls="project-chats-panel" onClick={() => setTab("chats")}>对话 ({chats.length})</button>
      <button role="tab" id="project-materials-tab" aria-selected={tab === "materials"} aria-controls="project-materials-panel" onClick={() => setTab("materials")}>最近资料</button>
    </div>
    <div className="project-overview-columns" data-active-tab={tab}>
      <section className="project-overview-chats" id="project-chats-panel" aria-labelledby="project-chats-tab">
        <h2>项目对话 <small>{chats.length}</small></h2>
        <div className="project-overview-list">
          {chats.map((item) => <button className="project-overview-chat" key={item.id} onClick={() => onOpen(item)} title={item.title}>
            {item.pinned_at ? <Pin size={17} aria-label="已置顶" /> : <MessageCircle size={17} />}<strong>{item.title}</strong>
            <time dateTime={item.updated_at}>{new Date(item.updated_at).toLocaleDateString("zh-CN")}</time>
          </button>)}
          {!chats.length && <div className="project-overview-empty"><p>项目里还没有对话。</p><Button variant="outline" onClick={onNew}><Plus size={15} />开始第一段对话</Button></div>}
        </div>
      </section>
      <section className="project-overview-materials" id="project-materials-panel" aria-labelledby="project-materials-tab">
        <div className="project-overview-section-heading"><h2>最近资料</h2><Button size="sm" variant="ghost" onClick={onLibrary}>查看全部</Button></div>
        <div className="project-overview-list">
          {error && <p role="alert">{error}</p>}{loading && <p role="status">正在读取项目资料…</p>}
          {materials.slice(0, 4).map((item) => <article className="project-recent-material" key={item.id}>
            {item.image ? <div className="project-overview-image"><Picture id={item.file_id} name={item.name} /><span title={item.name}>{item.name}</span></div> : <FileCard file={{ id: item.file_id, name: item.name }} upload compact />}
            {item.file_status !== "ready" && <small>{materialStatus(item)}</small>}
          </article>)}
          {!loading && !error && !materials.length && <p className="muted">上传资料后，同项目的对话都能按需读取。</p>}
          <Button className="project-upload-link" variant="ghost" onClick={onLibrary}><Upload size={15} />上传资料</Button>
        </div>
      </section>
    </div>
  </div>;
}
