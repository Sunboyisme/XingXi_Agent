import type { ReactNode } from "react";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import "@/styles/detail-view.css";

export function DetailDialog({
  title,
  label,
  description,
  className = "",
  children,
  open,
  onOpenChange,
}: {
  title: string;
  label?: ReactNode;
  description?: string;
  className?: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (value: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="detail-view-trigger"
        >
          {label ?? title}
        </Button>
      </DialogTrigger>
      <DialogContent className="detail-view-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? "" : "sr-only"}>
            {description || `${title}的完整内容`}
          </DialogDescription>
        </DialogHeader>
        <div className={`detail-view-body ${className}`}>{children}</div>
      </DialogContent>
    </Dialog>
  );
}
