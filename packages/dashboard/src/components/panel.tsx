import type { ReactNode } from "react";
import { MonoLabel } from "@kestrel/dashboard/components/mono-label";
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
    <section className={cn("flex flex-col border bg-card", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-dashed px-5 py-3">
          <div className="min-w-0 space-y-0.5">
            {typeof title === "string" ? (
              <MonoLabel as="h2">{title}</MonoLabel>
            ) : (
              title
            )}
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
