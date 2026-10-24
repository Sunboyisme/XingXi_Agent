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
}: {
  title: string;
  description: string;
  backLabel: string;
  onBack: () => void;
  busy?: boolean;
  children: ReactNode;
  actions: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="creation-page" aria-label={title}>
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
          <header>
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
            <p>{description}</p>
          </header>
          <div className="creation-fields">{children}</div>
        </div>
      </div>
      <footer className="creation-page-footer">
        <div>{actions}</div>
      </footer>
    </section>
  );
}
