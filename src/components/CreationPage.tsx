import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "./ui/button";
import "@/styles/creation-page.css";

export function CreationPage({
  title,
  description,
  backLabel,
  onBack,
  busy,
  children,
  actions,
  className = "",
  footerNote,
}: {
  title: string;
  description: string;
  backLabel: string;
  onBack: () => void;
  busy?: boolean;
  children: ReactNode;
  actions: ReactNode;
  className?: string;
  footerNote?: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className={`creation-page ${className}`} aria-label={title}>
      <div className="creation-page-scroll">
        <div className="creation-page-inner">
          <Button
            className="creation-back"
            variant="ghost"
            disabled={busy}
            onClick={onBack}
          >
            <ArrowLeft size={16} />
            {backLabel}
          </Button>
          <header className="creation-page-heading">
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
            <p>{description}</p>
          </header>
          <div className="creation-fields">{children}</div>
        </div>
      </div>
      <footer className="creation-page-footer">
        <div>
          {footerNote && <p className="creation-footer-note">{footerNote}</p>}
          {actions}
        </div>
      </footer>
    </section>
  );
}
