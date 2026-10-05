import type { SessionStatus } from "@kestrel/contracts";
import { humanize } from "@kestrel/dashboard/lib/format";
import { cn } from "@kestrel/dashboard/lib/utils";

/** Status always carries its word; the colour and dot are decoration, never the only signal. */
const TONE: Record<
  SessionStatus,
  { pill: string; dot: string; pulse?: boolean }
> = {
  requested: {
    pill: "border-input text-muted-foreground",
    dot: "bg-muted-foreground",
    pulse: true,
  },
  scheduling: {
    pill: "border-input text-muted-foreground",
    dot: "bg-muted-foreground",
    pulse: true,
  },
  starting: { pill: "border-info/50 bg-info/8", dot: "bg-info", pulse: true },
  ready: {
    pill: "border-success/60 bg-success/8",
    dot: "bg-success",
    pulse: true,
  },
  active: { pill: "border-brand bg-brand/12", dot: "bg-brand", pulse: true },
  stopping: { pill: "border-warning/50 bg-warning/8", dot: "bg-warning" },
  stopped: {
    pill: "border-input text-muted-foreground",
    dot: "bg-muted-foreground/70",
  },
  failed: {
    pill: "border-destructive/50 bg-destructive/8 text-destructive",
    dot: "bg-destructive",
  },
  timed_out: { pill: "border-warning/50 bg-warning/8", dot: "bg-warning" },
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
        "inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-[10.5px] font-medium tracking-[0.06em] uppercase whitespace-nowrap",
        TONE[status].pill,
        className,
      )}
    >
      <StatusDot status={status} className="size-1.5 [&>span]:size-1.5" />
      {humanize(status)}
    </span>
  );
}
