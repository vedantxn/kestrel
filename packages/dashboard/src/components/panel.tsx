import type { ReactNode } from "react";
import { cn } from "@kestrel/dashboard/lib/utils";

/** A card with a title row: the page's basic building block. */
export function Panel({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn("flex flex-col rounded-xl border bg-card", className)}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-1">
          <div className="min-w-0 space-y-0.5">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      <div className={cn("flex-1 px-5 py-4", bodyClassName)}>{children}</div>
    </section>
  );
}
