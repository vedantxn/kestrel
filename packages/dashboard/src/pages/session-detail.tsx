import type { Session, SessionEvent } from "@kestrel/contracts";
import {
  ArrowLeft,
  Download,
  Eye,
  MousePointerClick,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AutoRefresh } from "@kestrel/dashboard/components/auto-refresh";
import { CopyButton } from "@kestrel/dashboard/components/copy-button";
import { StopButton } from "@kestrel/dashboard/components/session-actions";
import { StatusBadge } from "@kestrel/dashboard/components/status-badge";
import { Button } from "@kestrel/dashboard/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@kestrel/dashboard/components/ui/card";
import type { DashboardActions } from "@kestrel/dashboard/lib/actions";
import {
  KestrelApiError,
  type KestrelClient,
} from "@kestrel/dashboard/lib/client";
import {
  CAPTCHA_LABEL,
  describeEvent,
  type EventTone,
} from "@kestrel/dashboard/lib/events";
import {
  formatDateTime,
  formatDuration,
  humanize,
  isLive,
  sessionDuration,
  timeAgo,
} from "@kestrel/dashboard/lib/format";
import { cn } from "@kestrel/dashboard/lib/utils";

export async function SessionDetailPage({
  client,
  base,
  id,
  actions,
}: {
  client: KestrelClient;
  base: string;
  id: string;
  actions: Pick<DashboardActions, "stopSession">;
}) {
  let session: Session;
  let events: SessionEvent[];
  try {
    [session, events] = await Promise.all([
      client.getSession(id),
      client.events(id),
    ]);
  } catch (e) {
    if (e instanceof KestrelApiError && e.status === 404) notFound();
    throw e;
  }
  const live = isLive(session.status);
  const canView = session.status === "ready" || session.status === "active";
  const here = `${base}/sessions/${session.id}`;
  const ready = events.find((e) => e.type === "session.ready");
  const o = session.options;

  return (
    <>
      {live && <AutoRefresh ms={3000} />}
      <div className="space-y-3">
        <Link
          href={`${base}/sessions`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Sessions
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate font-mono text-lg font-semibold tracking-tight md:text-xl">
              {session.id}
            </h1>
            <CopyButton value={session.id} label="Copy session id" />
            <StatusBadge status={session.status} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canView && (
              <>
                <Button asChild variant="outline" size="sm">
                  <a
                    href={`${here}/live`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Eye /> Watch live
                  </a>
                </Button>
                <Button asChild size="sm">
                  <a
                    href={`${here}/live?control=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <MousePointerClick /> Take control
                  </a>
                </Button>
              </>
            )}
            {o.recording && (
              <Button asChild variant="outline" size="sm">
                <a href={`${here}/recording`} download>
                  <Download /> Recording
                </a>
              </Button>
            )}
            {live && session.status !== "stopping" && (
              <StopButton id={session.id} stop={actions.stopSession} />
            )}
          </div>
        </div>
      </div>

      {session.captcha && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="font-medium">
              CAPTCHA on the page:{" "}
              {session.captcha.providers
                .map((p) => CAPTCHA_LABEL[p])
                .join(", ")}
            </p>
            <p className="text-muted-foreground">
              Since {timeAgo(session.captcha.since)}. Take control to solve it,
              then hand the browser back to the agent.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <Fields>
              <Field label="Created">
                {formatDateTime(session.createdAt)} UTC
              </Field>
              <Field label="Ready">{formatDateTime(session.readyAt)}</Field>
              <Field label="Ended">{formatDateTime(session.endedAt)}</Field>
              <Field label={live ? "Running for" : "Ran for"}>
                {session.readyAt
                  ? formatDuration(sessionDuration(session))
                  : "–"}
              </Field>
              <Field label="Start">
                {session.startPath
                  ? `${session.startPath}${ready?.type === "session.ready" ? `, ${Math.round(ready.data.readyMs)} ms` : ""}`
                  : "–"}
              </Field>
              <Field label="Node">{session.nodeId ?? "–"}</Field>
              <Field label="End reason">
                {session.endReason ? humanize(session.endReason) : "–"}
              </Field>
              <Field label="Browser time">
                {formatDuration(session.usage.browserSeconds)}
              </Field>
            </Fields>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Options</CardTitle>
          </CardHeader>
          <CardContent>
            <Fields cols={1}>
              <Field label="Viewport">
                {session.viewport.width} × {session.viewport.height} @
                {session.deviceScaleFactor}x
              </Field>
              <Field label="Timeout">{formatDuration(o.timeout / 1000)}</Field>
              <Field label="Idle timeout">
                {formatDuration(o.idleTimeout / 1000)}
              </Field>
              <Field label="Stop on disconnect">
                {o.stopOnDisconnect ? "Yes" : "No"}
              </Field>
              <Field label="Recording">{o.recording ? "On" : "Off"}</Field>
            </Fields>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Network</CardTitle>
          </CardHeader>
          <CardContent>
            <Fields cols={1}>
              <Field label="Proxy">
                {o.proxy
                  ? `${o.proxy.server}${o.proxy.username ? ` as ${o.proxy.username}` : ""}`
                  : "Direct"}
              </Field>
              <Field label="Allowed hosts">
                {o.network.allow?.length
                  ? o.network.allow.join(", ")
                  : "Any public host"}
              </Field>
              <Field label="Denied hosts">
                {o.network.deny?.length ? o.network.deny.join(", ") : "None"}
              </Field>
            </Fields>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(o.metadata).length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 font-mono text-xs">
                {Object.entries(o.metadata).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-all">
                      {typeof v === "string" ? v : JSON.stringify(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline events={events} />
        </CardContent>
      </Card>
    </>
  );
}

function Fields({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 }) {
  return (
    <dl
      className={cn(
        "grid gap-x-8 gap-y-3 text-sm",
        cols === 2 && "sm:grid-cols-2",
      )}
    >
      {children}
    </dl>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-dashed pb-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{children}</dd>
    </div>
  );
}

const DOT: Record<EventTone, string> = {
  default: "bg-muted-foreground/50",
  good: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
};

function Timeline({ events }: { events: SessionEvent[] }) {
  if (events.length === 0)
    return <p className="text-sm text-muted-foreground">No events.</p>;
  const t0 = new Date(events[0]!.at).getTime();
  return (
    <ol className="relative space-y-4 border-l pl-6">
      {events.map((e) => {
        const d = describeEvent(e);
        const offset = (new Date(e.at).getTime() - t0) / 1000;
        return (
          <li key={e.id} className="relative">
            <span
              className={cn(
                "absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full ring-4 ring-card",
                DOT[d.tone],
              )}
            />
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
              <p className="text-sm">
                <span className="font-medium">{d.title}</span>
                {d.detail && (
                  <span className="text-muted-foreground"> · {d.detail}</span>
                )}
              </p>
              <p className="font-mono text-xs text-muted-foreground tabular-nums">
                {formatDateTime(e.at)}
                <span className="ml-2 opacity-70">
                  +{formatDuration(offset)}
                </span>
              </p>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground/70">
              {e.type}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
