import type { SessionStatus } from "@kestrel/contracts";
import { humanize } from "@kestrel/dashboard/lib/format";
import { cn } from "@kestrel/dashboard/lib/utils";

/** Status always carries its word; the colour and dot are decoration, never the only signal. */
const TONE: Record<
  SessionStatus,
  { pill: string; dot: string; pulse?: boolean }
> = {
  requested: {
    pill: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
    pulse: true,
  },
  scheduling: {
    pill: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground",
    pulse: true,
  },
  starting: { pill: "bg-info/10 text-info", dot: "bg-info", pulse: true },
  ready: { pill: "bg-success/10 text-success", dot: "bg-success", pulse: true },
  active: {
    pill: "bg-primary/12 text-primary",
    dot: "bg-primary",
    pulse: true,
  },
  stopping: { pill: "bg-warning/10 text-warning", dot: "bg-warning" },
  stopped: {
    pill: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/70",
  },
  failed: { pill: "bg-destructive/12 text-destructive", dot: "bg-destructive" },
  timed_out: { pill: "bg-warning/10 text-warning", dot: "bg-warning" },
};

export function StatusDot({
  status,
  className,
}: {
  status: SessionStatus;
  className?: string;
}) {
  const tone = TONE[status];
  return (
    <span className={cn("relative flex size-2 shrink-0", className)}>
      {tone.pulse && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60",
            tone.dot,
          )}
        />
      )}
      <span
        className={cn("relative inline-flex size-2 rounded-full", tone.dot)}
      />
    </span>
  );
}

export function StatusBadge({
  status,
  className,
}: {
  status: SessionStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE[status].pill,
        className,
      )}
    >
      <StatusDot status={status} className="size-1.5 [&>span]:size-1.5" />
      {humanize(status)}
    </span>
  );
}
