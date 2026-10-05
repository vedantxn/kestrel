import type { SessionStatus } from "@kestrel/contracts";
import { humanize } from "@kestrel/dashboard/lib/format";
import { cn } from "@kestrel/dashboard/lib/utils";

/** Status always carries its word; the dot is decoration, never the only signal. */
const TONE: Record<SessionStatus, { dot: string; pulse?: boolean }> = {
  requested: { dot: "bg-muted-foreground", pulse: true },
  scheduling: { dot: "bg-muted-foreground", pulse: true },
  starting: { dot: "bg-warning", pulse: true },
  ready: { dot: "bg-success", pulse: true },
  active: { dot: "bg-primary", pulse: true },
  stopping: { dot: "bg-warning" },
  stopped: { dot: "bg-muted-foreground/60" },
  failed: { dot: "bg-destructive" },
  timed_out: { dot: "bg-warning" },
};

export function StatusBadge({
  status,
  className,
}: {
  status: SessionStatus;
  className?: string;
}) {
  const tone = TONE[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        status === "failed" && "border-destructive/40 text-destructive",
        className,
      )}
    >
      <span className="relative flex size-2">
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
      {humanize(status)}
    </span>
  );
}
