import type { Session } from "@kestrel/contracts";
import { Globe, ShieldAlert, Video } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@kestrel/dashboard/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@kestrel/dashboard/components/ui/table";
import {
  formatDuration,
  sessionDuration,
  timeAgo,
} from "@kestrel/dashboard/lib/format";

/** Up to two metadata pairs, as text. Metadata is the caller's, but still only text. */
function metadataSummary(m: Record<string, unknown>): string {
  return Object.entries(m)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
}

export function SessionsTable({
  sessions,
  base,
  empty = "No sessions yet.",
}: {
  sessions: Session[];
  base: string;
  empty?: string;
}) {
  if (sessions.length === 0)
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="w-32">Status</TableHead>
            <TableHead>Session</TableHead>
            <TableHead className="hidden md:table-cell">Metadata</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="hidden text-right lg:table-cell">
              Start
            </TableHead>
            <TableHead className="hidden lg:table-cell">Node</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow key={s.id} className="group">
              <TableCell>
                <StatusBadge status={s.status} />
              </TableCell>
              <TableCell className="font-mono text-xs">
                <Link
                  href={`${base}/sessions/${s.id}`}
                  className="hover:text-primary hover:underline"
                >
                  {s.id}
                </Link>
              </TableCell>
              <TableCell className="hidden max-w-56 truncate font-mono text-xs text-muted-foreground md:table-cell">
                {metadataSummary(s.options.metadata)}
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {timeAgo(s.createdAt)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {s.status === "failed" && !s.readyAt
                  ? "–"
                  : formatDuration(sessionDuration(s))}
              </TableCell>
              <TableCell className="hidden text-right text-muted-foreground lg:table-cell">
                {s.startPath ?? "–"}
              </TableCell>
              <TableCell className="hidden text-muted-foreground lg:table-cell">
                {s.nodeId ?? "–"}
              </TableCell>
              <TableCell>
                <span className="flex justify-end gap-1.5 text-muted-foreground">
                  {s.captcha && (
                    <ShieldAlert
                      className="size-4 text-warning"
                      aria-label="CAPTCHA on page"
                    />
                  )}
                  {s.options.proxy && (
                    <Globe className="size-4" aria-label="Through a proxy" />
                  )}
                  {s.options.recording && (
                    <Video className="size-4" aria-label="Recorded" />
                  )}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
