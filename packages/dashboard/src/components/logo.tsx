import { cn } from "@kestrel/dashboard/lib/utils";

/** The bird alone: a hovering kestrel, wings swept, tail down. */
export const KESTREL_MARK_PATH =
  "M16 14.2 3.4 8.4l4.9 7.2 6.3 1.7L16 25.6l1.4-8.3 6.3-1.7 4.9-7.2Z";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("size-8 shrink-0", className)}
    >
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d={KESTREL_MARK_PATH} className="fill-primary-foreground" />
      <circle cx="16" cy="11.6" r="2.4" className="fill-primary-foreground" />
    </svg>
  );
}

export function Logo({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={markClassName} />
      <span className="text-[1.05rem] font-semibold tracking-tight">
        kestrel
      </span>
    </span>
  );
}
