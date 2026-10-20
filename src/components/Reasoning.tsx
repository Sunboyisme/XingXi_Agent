import { useEffect, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
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
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
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
        onClick={() => setOpen(!open)}
      >
        <Sparkles size={15} aria-hidden="true" />
        <span>
          {active
            ? "XiaoXi 正在想…"
            : incomplete
              ? "这个想法还没说完"
              : "看看 XiaoXi 的小想法"}
        </span>
        <ChevronDown size={15} className={open ? "is-open" : ""} />
      </button>
      {open && (
        <div className="reasoning-content">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </section>
  );
}
