import type { Session } from "@kestrel/contracts";
import {
  ArrowRight,
  Clock,
  Gauge,
  KeyRound,
  Layers,
  Radio,
} from "lucide-react";
import Link from "next/link";
import { AutoRefresh } from "@kestrel/dashboard/components/auto-refresh";
import { DailyChart } from "@kestrel/dashboard/components/charts";
import { PageHeader } from "@kestrel/dashboard/components/page-header";
import { Panel } from "@kestrel/dashboard/components/panel";
import { SessionsTable } from "@kestrel/dashboard/components/sessions-table";
import { Stat } from "@kestrel/dashboard/components/stat";
import { StatusDot } from "@kestrel/dashboard/components/status-badge";
import { Button } from "@kestrel/dashboard/components/ui/button";
import type { KestrelClient } from "@kestrel/dashboard/lib/client";
import {
  change,
  formatDuration,
  formatMs,
  isLive,
  percentile,
  sessionDuration,
  shortId,
} from "@kestrel/dashboard/lib/format";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export async function OverviewPage({
  client,
  base,
}: {
  client: KestrelClient;
  base: string;
}) {
  const [project, fortnight, month, recent] = await Promise.all([
    client.project(),
    client.usage(14),
    client.usage(30),
    client.listSessions({ limit: 100 }),
  ]);
  const prev = fortnight.days.slice(0, 7);
  const week = fortnight.days.slice(7);
  const sessions7 = sum(week.map((d) => d.sessions));
  const minutes7 = sum(week.map((d) => d.browserSeconds)) / 60;
  const failed7 = sum(week.map((d) => d.failed));

  const ready = recent.data
    .filter((s) => s.readyAt)
    .map(
      (s) => new Date(s.readyAt!).getTime() - new Date(s.createdAt).getTime(),
    );
  const p50 = percentile(ready, 50);
  const p95 = percentile(ready, 95);
  const hot = recent.data.filter((s) => s.startPath === "hot").length;
  const started = recent.data.filter((s) => s.startPath).length;
  const live = recent.data.filter((s) => isLive(s.status));

  return (
    <>
      <AutoRefresh ms={5000} />
      <PageHeader
        title="Overview"
        description={`${project.name} · the last 7 days, refreshed live`}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`${base}/api-keys`}>
                <KeyRound /> API keys
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`${base}/sessions`}>
                Sessions <ArrowRight />
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Live now"
          live={fortnight.live > 0}
          value={fortnight.live}
          icon={Radio}
          hint={`of ${project.quotas.maxConcurrentSessions} allowed at once`}
        />
        <Stat
          label="Sessions"
          value={sessions7}
          icon={Layers}
          delta={change(sessions7, sum(prev.map((d) => d.sessions)))}
          trend={fortnight.days.map((d) => d.sessions)}
          hint={`${failed7} failed`}
        />
        <Stat
          label="Browser time"
          value={Math.round(minutes7)}
          unit="min"
          icon={Clock}
          delta={change(minutes7, sum(prev.map((d) => d.browserSeconds)) / 60)}
          trend={fortnight.days.map((d) => d.browserSeconds)}
        />
        <Stat
          label="Time to ready, p50"
          value={p50 ?? 0}
          unit="ms"
          icon={Gauge}
          hint={
            p95 !== null && started
              ? `p95 ${formatMs(p95)} · ${Math.round((hot / started) * 100)}% hot starts`
              : "No sessions yet"
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Sessions per day"
          description="Last 30 days, UTC"
          action={
            <span className="text-2xl font-semibold tabular-nums">
              {month.totals.sessions.toLocaleString("en-US")}
            </span>
          }
        >
          <DailyChart
            label="Sessions"
            data={month.days.map((d) => ({ date: d.date, value: d.sessions }))}
          />
        </Panel>
        <LiveNow sessions={live} base={base} />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent sessions</h2>
          <Link
            href={`${base}/sessions`}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            View all <ArrowRight className="size-3.5" />
          </Link>
        </div>
        <SessionsTable
          compact
          sessions={recent.data.slice(0, 8)}
          base={base}
          empty="Create a session with the SDK, the CLI or MCP and it shows up here."
        />
      </div>
    </>
  );
}

function LiveNow({ sessions, base }: { sessions: Session[]; base: string }) {
  return (
    <Panel
      title="Live now"
      description={
        sessions.length ? `${sessions.length} running` : "Nothing running"
      }
      bodyClassName="px-2 pb-2"
    >
      {sessions.length === 0 ? (
        <div className="flex h-full flex-col justify-center gap-3 px-3 py-6">
          <p className="text-sm text-muted-foreground">
            Start a browser and it appears here while it runs.
          </p>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed">
            <span className="text-muted-foreground">
              {"// npm i @kestrel/sdk\n"}
            </span>
            {"const { browser } = await kestrel.connect();\n"}
            {"const page = await browser.newPage();"}
          </pre>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {sessions.slice(0, 6).map((s) => (
            <li key={s.id}>
              <Link
                href={`${base}/sessions/${s.id}`}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/60"
              >
                <StatusDot status={s.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px]">
                    {shortId(s.id)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {String(s.options.metadata.agent ?? s.nodeId ?? "")}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {formatDuration(sessionDuration(s))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
