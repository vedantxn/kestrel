import { Activity, Clock, Layers, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { AutoRefresh } from "@kestrel/dashboard/components/auto-refresh";
import { DailyBars } from "@kestrel/dashboard/components/charts";
import { PageHeader } from "@kestrel/dashboard/components/page-header";
import { SessionsTable } from "@kestrel/dashboard/components/sessions-table";
import { Stat } from "@kestrel/dashboard/components/stat";
import { Button } from "@kestrel/dashboard/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@kestrel/dashboard/components/ui/card";
import type { KestrelClient } from "@kestrel/dashboard/lib/client";

export async function OverviewPage({
  client,
  base,
}: {
  client: KestrelClient;
  base: string;
}) {
  const [project, week, month, recent] = await Promise.all([
    client.project(),
    client.usage(7),
    client.usage(30),
    client.listSessions({ limit: 8 }),
  ]);
  const failRate = week.totals.sessions
    ? Math.round((week.totals.failed / week.totals.sessions) * 1000) / 10
    : 0;

  return (
    <>
      <AutoRefresh ms={5000} />
      <PageHeader
        title="Overview"
        description={`What ${project.name} has been doing.`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}/sessions`}>All sessions</Link>
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Live sessions"
          value={week.live}
          icon={Activity}
          hint={`of ${project.quotas.maxConcurrentSessions} allowed at once`}
        />
        <Stat
          label="Sessions, 7 days"
          value={week.totals.sessions}
          icon={Layers}
          hint={`${week.totals.failed} failed (${failRate}%)`}
        />
        <Stat
          label="Browser time, 7 days"
          value={Math.round(week.totals.browserSeconds / 60)}
          unit="min"
          icon={Clock}
        />
        <Stat
          label="Met a CAPTCHA, 7 days"
          value={week.totals.captchaSessions}
          icon={ShieldAlert}
          hint="sessions with at least one"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Sessions per day</CardTitle>
          <CardDescription>Last 30 days, UTC</CardDescription>
        </CardHeader>
        <CardContent>
          <DailyBars
            label="Sessions"
            data={month.days.map((d) => ({ date: d.date, value: d.sessions }))}
          />
        </CardContent>
      </Card>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">
            Recent sessions
          </h2>
          <Link
            href={`${base}/sessions`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            View all
          </Link>
        </div>
        <SessionsTable
          sessions={recent.data}
          base={base}
          empty="No sessions yet. Create one with the SDK, the CLI or MCP and it appears here."
        />
      </div>
    </>
  );
}
