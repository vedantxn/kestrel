import { Clock, Layers, ShieldAlert, TriangleAlert } from "lucide-react";
import { DailyChart } from "@kestrel/dashboard/components/charts";
import { PageHeader } from "@kestrel/dashboard/components/page-header";
import { Panel } from "@kestrel/dashboard/components/panel";
import { Stat } from "@kestrel/dashboard/components/stat";
import type { KestrelClient } from "@kestrel/dashboard/lib/client";
import { humanize } from "@kestrel/dashboard/lib/format";
import { Segmented } from "@kestrel/dashboard/components/segmented";

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
  const ended = usage.byEndReason.reduce((n, r) => n + r.sessions, 0);
  const q = project.quotas;
  const livePct = Math.min(100, (usage.live / q.maxConcurrentSessions) * 100);

  return (
    <>
      <PageHeader
        title="Usage"
        description="Whole UTC days, today included. Browser time counts on the day a session was created."
        actions={
          <Segmented
            options={RANGES.map((r) => ({
              label: `${r} days`,
              value: String(r),
            }))}
            value={String(days)}
            href={(v) => `${base}/usage?days=${v}`}
          />
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Sessions"
          value={usage.totals.sessions}
          icon={Layers}
          trend={usage.days.map((d) => d.sessions)}
        />
        <Stat
          label="Browser time"
          value={Math.round(usage.totals.browserSeconds / 60)}
          unit="min"
          icon={Clock}
          trend={usage.days.map((d) => d.browserSeconds)}
        />
        <Stat
          label="Failed"
          value={usage.totals.failed}
          icon={TriangleAlert}
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
          hint={
            usage.totals.sessions
              ? `${((usage.totals.captchaSessions / usage.totals.sessions) * 100).toFixed(1)}% of sessions`
              : undefined
          }
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Sessions per day">
          <DailyChart
            label="Sessions"
            data={usage.days.map((d) => ({ date: d.date, value: d.sessions }))}
          />
        </Panel>
        <Panel title="Browser minutes per day">
          <DailyChart
            label="Browser time"
            unit="min"
            data={usage.days.map((d) => ({
              date: d.date,
              value: Math.round((d.browserSeconds / 60) * 10) / 10,
            }))}
          />
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title="Why sessions ended"
          description={`${ended.toLocaleString("en-US")} sessions ended in the range`}
        >
          {usage.byEndReason.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has ended yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {usage.byEndReason.map((r) => (
                <li key={r.endReason} className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span>{humanize(r.endReason)}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {r.sessions}
                      <span className="ml-2 inline-block w-12 text-right">
                        {((r.sessions / ended) * 100).toFixed(1)}%
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden  bg-muted">
                    <div
                      className="h-full  bg-chart-1"
                      style={{ width: `${(r.sessions / ended) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Limits" description="Set per project by the operator">
          <div className="space-y-5 text-sm">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Live sessions</span>
                <span className="tabular-nums">
                  {usage.live} / {q.maxConcurrentSessions}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden  bg-muted">
                <div
                  className="h-full  bg-chart-1"
                  style={{ width: `${livePct}%` }}
                />
              </div>
            </div>
            <div className="flex justify-between border-t pt-4">
              <span className="text-muted-foreground">Creates per minute</span>
              <span className="tabular-nums">{q.createsPerMinute}</span>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
