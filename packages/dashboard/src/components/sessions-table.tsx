import type { Session } from "@kestrel/contracts";
import { Globe, Inbox, ShieldAlert, Video } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { StatusBadge } from "@kestrel/dashboard/components/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@kestrel/dashboard/components/ui/tooltip";
import {
  formatDuration,
  formatMs,
  sessionDuration,
  shortId,
  timeAgo,
} from "@kestrel/dashboard/lib/format";
import { cn } from "@kestrel/dashboard/lib/utils";

/** Metadata pairs as small chips of text. Metadata is the caller's, but still only text. */
function MetadataChips({ m }: { m: Record<string, unknown> }) {
  const pairs = Object.entries(m).slice(0, 2);
  if (pairs.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {pairs.map(([k, v]) => (
        <span
          key={k}
          className="max-w-40 truncate rounded bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground"
        >
          <span className="opacity-60">{k}:</span>{" "}
          {typeof v === "string" ? v : JSON.stringify(v)}
        </span>
      ))}
    </span>
  );
}

function Flag({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative z-10" aria-label={label}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function EmptyState({
  title,
  children,
  icon: Icon = Inbox,
}: {
  title: string;
  children?: ReactNode;
  icon?: typeof Inbox;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      {children && (
        <div className="max-w-sm text-sm text-muted-foreground">{children}</div>
      )}
    </div>
  );
}

const readyMs = (s: Session) =>
  s.readyAt
    ? new Date(s.readyAt).getTime() - new Date(s.createdAt).getTime()
    : null;

export function SessionsTable({
  sessions,
  base,
  empty = "No sessions yet.",
  compact = false,
}: {
  sessions: Session[];
  base: string;
  empty?: ReactNode;
  compact?: boolean;
}) {
  if (sessions.length === 0)
    return <EmptyState title="Nothing here">{empty}</EmptyState>;
  const th = "px-4 py-2.5 text-left text-xs font-medium text-muted-foreground";
  const td = "px-4 py-3 align-middle";
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/30">
          <tr>
            <th className={th}>Session</th>
            <th className={th}>Status</th>
            <th className={th}>Started</th>
            <th className={cn(th, "text-right")}>Duration</th>
            {!compact && (
              <th className={cn(th, "hidden text-right lg:table-cell")}>
                Ready in
              </th>
            )}
            {!compact && (
              <th className={cn(th, "hidden lg:table-cell")}>Node</th>
            )}
            <th className={cn(th, "w-20")} />
          </tr>
        </thead>
        <tbody className="divide-y">
          {sessions.map((s) => {
            const r = readyMs(s);
            return (
              <tr
                key={s.id}
                className="group relative transition-colors hover:bg-muted/40"
              >
                <td className={td}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <Link
                      href={`${base}/sessions/${s.id}`}
                      className="font-mono text-[13px] font-medium after:absolute after:inset-0 group-hover:text-primary"
                    >
                      {shortId(s.id)}
                    </Link>
                    <MetadataChips m={s.options.metadata} />
                  </div>
                </td>
                <td className={td}>
                  <StatusBadge status={s.status} />
                </td>
                <td
                  className={cn(td, "whitespace-nowrap text-muted-foreground")}
                >
                  {timeAgo(s.createdAt)}
                </td>
                <td
                  className={cn(
                    td,
                    "text-right whitespace-nowrap tabular-nums",
                  )}
                >
                  {s.status === "failed" && !s.readyAt
                    ? "–"
                    : formatDuration(sessionDuration(s))}
                </td>
                {!compact && (
                  <td
                    className={cn(
                      td,
                      "hidden text-right whitespace-nowrap lg:table-cell",
                    )}
                  >
                    {r === null ? (
                      <span className="text-muted-foreground">–</span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={cn(
                            "rounded px-1.5 py-px text-[11px] font-medium",
                            s.startPath === "hot"
                              ? "bg-primary/12 text-primary"
                              : "bg-info/10 text-info",
                          )}
                        >
                          {s.startPath}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatMs(r)}
                        </span>
                      </span>
                    )}
                  </td>
                )}
                {!compact && (
                  <td
                    className={cn(
                      td,
                      "hidden font-mono text-xs text-muted-foreground lg:table-cell",
                    )}
                  >
                    {s.nodeId ?? "–"}
                  </td>
                )}
                <td className={td}>
                  <span className="flex justify-end gap-2 text-muted-foreground">
                    {s.captcha && (
                      <Flag label="CAPTCHA on the page">
                        <ShieldAlert className="size-4 text-warning" />
                      </Flag>
                    )}
                    {s.options.proxy && (
                      <Flag label="Through a proxy">
                        <Globe className="size-4" />
                      </Flag>
                    )}
                    {s.options.recording && (
                      <Flag label="Recorded">
                        <Video className="size-4" />
                      </Flag>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
