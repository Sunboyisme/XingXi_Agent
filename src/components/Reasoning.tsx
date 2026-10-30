import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Markdown } from "./common";

export function Reasoning({
  text,
  active = false,
  incomplete = false,
}: {
  text: string;
  active?: boolean;
  incomplete?: boolean;
}) {
  const [open, setOpen] = useState(active);
  const contentId = useId();
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    setOpen(active);
    following.current = true;
  }, [active]);
  useEffect(() => {
    const element = content.current;
    if (active && open && element && following.current)
      element.scrollTop = element.scrollHeight;
  }, [text, active, open]);
  if (!text) return null;
  return (
    <section
      className={`reasoning-panel ${active ? "is-active" : ""}`}
      aria-label="XiaoXi的思考"
    >
      <button
        type="button"
        className="reasoning-toggle"
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span>
          {active
            ? "XiaoXi 正在思考"
            : incomplete
              ? "这个想法还没说完"
              : "看看 XiaoXi 的想法"}
        </span>
        <ChevronDown
          size={15}
          className={open ? "is-open" : ""}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          className="reasoning-content"
          id={contentId}
          role="region"
          aria-label="思考内容"
          tabIndex={0}
          ref={content}
          onWheel={(event) => {
            if (event.deltaY < 0) following.current = false;
          }}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              24;
          }}
        >
          <Markdown>{text}</Markdown>
        </div>
      )}
    </section>
  );
}
