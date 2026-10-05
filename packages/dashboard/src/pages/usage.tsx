import { Activity, Clock, Layers, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { DailyBars } from "@kestrel/dashboard/components/charts";
import { PageHeader } from "@kestrel/dashboard/components/page-header";
import { Stat } from "@kestrel/dashboard/components/stat";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@kestrel/dashboard/components/ui/card";
import { Progress } from "@kestrel/dashboard/components/ui/progress";
import type { KestrelClient } from "@kestrel/dashboard/lib/client";
import { humanize } from "@kestrel/dashboard/lib/format";
import { cn } from "@kestrel/dashboard/lib/utils";

const RANGES = [7, 30, 90] as const;

export async function UsagePage({
  client,
  base,
  searchParams,
}: {
  client: KestrelClient;
  base: string;
  searchParams: { days?: string | string[] };
}) {
  const asked = Number(
    Array.isArray(searchParams.days) ? searchParams.days[0] : searchParams.days,
  );
  const days = (RANGES as readonly number[]).includes(asked) ? asked : 30;
  const [usage, project] = await Promise.all([
    client.usage(days),
    client.project(),
  ]);
  const maxReason = Math.max(1, ...usage.byEndReason.map((r) => r.sessions));
  const q = project.quotas;

  return (
    <>
      <PageHeader
        title="Usage"
        description="Whole UTC days, today included. Browser time counts on the day a session was created."
        actions={
          <nav className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
            {RANGES.map((r) => (
              <Link
                key={r}
                href={`${base}/usage?days=${r}`}
                className={cn(
                  "rounded-md px-3 py-1 text-muted-foreground hover:text-foreground",
                  r === days && "bg-background text-foreground shadow-sm",
                )}
              >
                {r} days
              </Link>
            ))}
          </nav>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Sessions" value={usage.totals.sessions} icon={Layers} />
        <Stat
          label="Browser time"
          value={Math.round(usage.totals.browserSeconds / 60)}
          unit="min"
          icon={Clock}
        />
        <Stat
          label="Failed"
          value={usage.totals.failed}
          icon={Activity}
          hint={
            usage.totals.sessions
              ? `${((usage.totals.failed / usage.totals.sessions) * 100).toFixed(1)}% of sessions`
              : undefined
          }
        />
        <Stat
          label="Met a CAPTCHA"
          value={usage.totals.captchaSessions}
          icon={ShieldAlert}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Sessions per day</CardTitle>
          </CardHeader>
          <CardContent>
            <DailyBars
              label="Sessions"
              data={usage.days.map((d) => ({
                date: d.date,
                value: d.sessions,
              }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Browser minutes per day</CardTitle>
          </CardHeader>
          <CardContent>
            <DailyBars
              label="Browser time"
              unit="min"
              data={usage.days.map((d) => ({
                date: d.date,
                value: Math.round((d.browserSeconds / 60) * 10) / 10,
              }))}
            />
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Why sessions ended</CardTitle>
            <CardDescription>
              Sessions in the range that have ended
            </CardDescription>
          </CardHeader>
          <CardContent>
            {usage.byEndReason.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing has ended yet.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {usage.byEndReason.map((r) => (
                  <li
                    key={r.endReason}
                    className="grid grid-cols-[10rem_1fr_3rem] items-center gap-3 text-sm"
                  >
                    <span className="truncate text-muted-foreground">
                      {humanize(r.endReason)}
                    </span>
                    <span className="h-2 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-chart-1"
                        style={{ width: `${(r.sessions / maxReason) * 100}%` }}
                      />
                    </span>
                    <span className="text-right tabular-nums">
                      {r.sessions}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Quotas</CardTitle>
            <CardDescription>Set per project by the operator</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Live sessions</span>
                <span className="tabular-nums">
                  {usage.live} / {q.maxConcurrentSessions}
                </span>
              </div>
              <Progress value={(usage.live / q.maxConcurrentSessions) * 100} />
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Creates per minute</span>
              <span className="tabular-nums">{q.createsPerMinute}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
