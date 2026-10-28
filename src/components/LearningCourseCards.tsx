import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, Loader2 } from "lucide-react";
import { api, type Run } from "@/lib/api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export type CourseReceipt = {
  goal_id: string;
  planning_run_id: string;
  title: string;
  status: string;
  completed_at?: string;
  error?: string | null;
  overview?: string;
  nodes: { id: string; title: string; module: string; objective: string }[];
};
export function LearningCourseCards({
  runId,
  courses: liveCourses,
  onOpen,
}: {
  runId: string;
  courses?: CourseReceipt[];
  onOpen: (course: CourseReceipt) => void;
}) {
  const [saved, setSaved] = useState<CourseReceipt[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (liveCourses) return;
    let live = true;
    void api<Run>(`/runs/${runId}`)
      .then((run) => {
        if (live)
          setSaved(
            (run.result.learning_courses as CourseReceipt[] | undefined) || [],
          );
      })
      .catch(() => {
        if (live) setError("本次课程记录暂时无法读取。");
      });
    return () => {
      live = false;
    };
  }, [runId, liveCourses]);
  return (
    <div className="learning-course-cards">
      {(liveCourses || saved).map((course) => (
        <article key={course.goal_id} className="learning-course-card">
          <BookOpen size={20} />
          <div>
            <strong>{course.title}</strong>
            <small>
              {course.status === "completed" && course.nodes.length
                ? `本次课程已保存 · ${course.nodes.length} 个章节`
                : course.status === "running"
                  ? "正在生成本次课程目录…"
                  : course.error || "本次课程生成尚未完成，可重试当前请求。"}
            </small>
          </div>
          {course.status === "completed" && course.nodes.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => onOpen(course)}>
              查看目录
              <ChevronRight size={15} />
            </Button>
          ) : course.status === "running" ? (
            <Loader2 size={16} className="spin" />
          ) : null}
        </article>
      ))}
      {error && <p role="status">{error}</p>}
    </div>
  );
}
export function CourseOutline({
  course,
  onClose,
}: {
  course: CourseReceipt | null;
  onClose: () => void;
}) {
  const groups = new Map<string, CourseReceipt["nodes"]>();
  for (const node of course?.nodes || [])
    groups.set(node.module || "课程章节", [
      ...(groups.get(node.module || "课程章节") || []),
      node,
    ]);
  const [error, setError] = useState("");
  useEffect(() => setError(""), [course?.goal_id]);
  return (
    <Dialog
      open={Boolean(course)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="course-outline-dialog">
        <DialogHeader>
          <DialogTitle>{course?.title}</DialogTitle>
          <DialogDescription>
            {course?.overview || "本次新建课程的模块与章节"}
          </DialogDescription>
        </DialogHeader>
        <div className="course-outline-body">
          {[...groups].map(([module, nodes]) => (
            <section key={module}>
              <h3>{module}</h3>
              <ol>
                {nodes.map((node) => (
                  <li key={node.id}>
                    <strong>{node.title}</strong>
                    <p>{node.objective}</p>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            稍后学习
          </Button>
          <Button
            onClick={() =>
              void (async () => {
                if (!course) return;
                try {
                  await api(`/learning/goals/${course.goal_id}`);
                  window.dispatchEvent(
                    new CustomEvent("xiaoxi-open-learning", {
                      detail: { goalId: course.goal_id, key: Date.now() },
                    }),
                  );
                  onClose();
                } catch {
                  setError("这份课程暂时无法读取，请稍后再试。");
                }
              })()
            }
          >
            开始学习
            <ChevronRight size={15} />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
