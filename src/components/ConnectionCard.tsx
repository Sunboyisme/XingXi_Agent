import { Hint } from "./common";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { Button } from "./ui/button";

export function ConnectionCard({
  title,
  description,
  status,
  detail,
  icon: Icon,
  ready = false,
  action = "配置",
  onConfigure,
  children,
}: {
  title: string;
  description: string;
  status: string;
  detail: string;
  icon: LucideIcon;
  ready?: boolean;
  action?: string;
  onConfigure: () => void;
  children?: React.ReactNode;
}) {
  return (
    <section className="service-card" aria-label={title}>
      <div className="service-card-top">
        <span className="service-card-icon">
          <Icon size={20} />
        </span>
        <span className={`service-status ${ready ? "ready" : ""}`}>
          <i />
          {status}
        </span>
      </div>
      <h3>{title}</h3>
      <p className="service-card-description">{description}</p>
      <div className="service-card-bottom">
        <Hint label={detail}>
          <span>{detail}</span>
        </Hint>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`${action}${title}`}
          onClick={onConfigure}
        >
          {action}
          <ArrowUpRight size={14} />
        </Button>
      </div>
      {children}
    </section>
  );
}
