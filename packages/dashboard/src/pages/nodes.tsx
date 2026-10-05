import { Activity, Cpu, Flame, Server } from "lucide-react";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@kestrel/dashboard/components/auto-refresh";
import { PageHeader } from "@kestrel/dashboard/components/page-header";
import { Stat } from "@kestrel/dashboard/components/stat";
import { Badge } from "@kestrel/dashboard/components/ui/badge";
import { Progress } from "@kestrel/dashboard/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@kestrel/dashboard/components/ui/table";
import {
  KestrelApiError,
  type KestrelClient,
} from "@kestrel/dashboard/lib/client";
import { timeAgo } from "@kestrel/dashboard/lib/format";

/** Admin keys only: the API answers `not_found` to any other key, and so does this page. */
export async function NodesPage({ client }: { client: KestrelClient }) {
  let nodes;
  try {
    ({ data: nodes } = await client.adminNodes());
  } catch (e) {
    if (e instanceof KestrelApiError && e.status === 404) notFound();
    throw e;
  }
  const active = nodes.filter((n) => n.state === "active" && !n.fenced);
  const slots = active.reduce((n, x) => n + x.slotsTotal, 0);
  const live = nodes.reduce((n, x) => n + x.liveSessions, 0);
  const hot = active.reduce((n, x) => n + x.hotCount, 0);

  return (
    <>
      <AutoRefresh ms={5000} />
      <PageHeader
        title="Nodes"
        description="The machines that run browsers, across every project."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Nodes taking sessions"
          value={active.length}
          icon={Server}
          hint={`of ${nodes.length}`}
        />
        <Stat
          label="Slots"
          value={slots}
          icon={Cpu}
          hint="on nodes taking sessions"
        />
        <Stat label="Live sessions" value={live} icon={Activity} />
        <Stat
          label="Hot browsers"
          value={hot}
          icon={Flame}
          hint="started and waiting"
        />
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>Node</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="w-56">Sessions / slots</TableHead>
              <TableHead className="text-right">Hot</TableHead>
              <TableHead>Last heartbeat</TableHead>
              <TableHead className="hidden md:table-cell">Runtime</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-8 text-center text-muted-foreground"
                >
                  No node has registered.
                </TableCell>
              </TableRow>
            )}
            {nodes.map((n) => (
              <TableRow key={n.id}>
                <TableCell className="font-mono font-medium">{n.id}</TableCell>
                <TableCell>
                  {n.state === "lost" ? (
                    <Badge variant="destructive">
                      Lost {timeAgo(n.lostAt)}
                    </Badge>
                  ) : n.fenced ? (
                    <Badge
                      variant="outline"
                      className="border-warning/50 text-warning"
                    >
                      Fenced
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-success/40 text-success"
                    >
                      Active
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Progress
                      value={
                        n.slotsTotal ? (n.liveSessions / n.slotsTotal) * 100 : 0
                      }
                      className="h-1.5"
                    />
                    <span className="shrink-0 text-xs tabular-nums">
                      {n.liveSessions} / {n.slotsTotal}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {n.hotCount}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {timeAgo(n.lastHeartbeatAt)}
                </TableCell>
                <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                  {n.runtimeVersion || "–"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
