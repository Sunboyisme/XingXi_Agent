import { useMemo, useState } from "react";
import { Folder, MessageCircle, Plus, Search } from "lucide-react";
import type { Conversation, Project } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Hint } from "./ui/hint";
import "@/styles/projects-workspace.css";

export function ProjectsPage({ projects, conversations, onOpen, onCreate }: {
  projects: Project[]; conversations: Conversation[]; onOpen: (id: string) => void; onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const values = useMemo(() => {
    const activity = new Map<string, { count: number; latest: string }>();
    for (const chat of conversations) {
      if (!chat.project_id) continue;
      const old = activity.get(chat.project_id);
      activity.set(chat.project_id, { count: (old?.count || 0) + 1, latest: old && old.latest > chat.updated_at ? old.latest : chat.updated_at });
    }
    return projects.map((project) => {
      const item = activity.get(project.id);
      return { project, count: item?.count || 0, latest: item && item.latest > project.updated_at ? item.latest : project.updated_at };
    }).filter(({ project }) => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      .sort((a, b) => b.latest.localeCompare(a.latest) || a.project.name.localeCompare(b.project.name));
  }, [projects, conversations, query]);
  return <div className="projects-page">
    <header className="projects-page-header"><div><h1>项目</h1><p>把相关对话和资料放在一起，随时接着处理。</p></div><Button onClick={onCreate}><Plus size={16} />新建项目</Button></header>
    <div className="projects-search"><Search size={17} /><Input value={query} maxLength={200} aria-label="搜索项目名称" placeholder="搜索项目名称…" onChange={(event) => setQuery(event.target.value)} /><span>{values.length} 个项目</span></div>
    <div className="projects-grid">
      {values.map(({ project, count, latest }) => <Hint key={project.id} label={project.name}><button className="project-entry-card" onClick={() => onOpen(project.id)}>
        <Folder size={24} /><strong>{project.name}</strong><p>{project.instructions || "还没有项目说明"}</p>
        <footer><span><MessageCircle size={14} />{count} 个对话</span><time dateTime={latest}>{new Date(latest).toLocaleDateString("zh-CN")}</time></footer>
      </button></Hint>)}
      {!values.length && <div className="projects-empty"><Folder size={30} /><p>{query.trim() ? "没有找到匹配的项目。" : "还没有项目，创建一个来整理相关对话和资料。"}</p>{!query.trim() && <Button variant="outline" onClick={onCreate}>创建第一个项目</Button>}</div>}
    </div>
  </div>;
}
