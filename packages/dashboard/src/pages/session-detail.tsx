import type { Session, SessionEvent } from "@kestrel/contracts";
import {
  CircleAlert,
  CirclePlay,
  CircleStop,
  Download,
  Eye,
  Globe,
  Link2,
  Link2Off,
  MousePointerClick,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AutoRefresh } from "@kestrel/dashboard/components/auto-refresh";
import { CopyButton } from "@kestrel/dashboard/components/copy-button";
import { Panel } from "@kestrel/dashboard/components/panel";
import { StopButton } from "@kestrel/dashboard/components/session-actions";
import { StatusBadge } from "@kestrel/dashboard/components/status-badge";
import { Button } from "@kestrel/dashboard/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@kestrel/dashboard/components/ui/tabs";
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
  formatMs,
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
  const o = session.options;
  const readyMs = session.readyAt
    ? new Date(session.readyAt).getTime() -
      new Date(session.createdAt).getTime()
    : null;
  const agent = o.metadata.agent;

  return (
    <>
      {live && <AutoRefresh ms={3000} />}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate font-mono text-xl font-semibold tracking-tight">
              {session.id}
            </h1>
            <CopyButton value={session.id} label="Copy session id" />
            <StatusBadge status={session.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            Created {timeAgo(session.createdAt)}
            {typeof agent === "string" ? ` by ${agent}` : ""}
            {session.nodeId ? ` · node ${session.nodeId}` : ""}
            {session.endReason ? ` · ${humanize(session.endReason)}` : ""}
          </p>
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

      {session.captcha && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/8 p-4 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="flex-1">
            <p className="font-medium">
              A CAPTCHA is on the page:{" "}
              {session.captcha.providers
                .map((p) => CAPTCHA_LABEL[p])
                .join(", ")}
            </p>
            <p className="text-muted-foreground">
              Since {timeAgo(session.captcha.since)}. Take control, solve it,
              then hand the browser back to the agent.
            </p>
          </div>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-5">
        <Fact label={live ? "Running for" : "Ran for"}>
          {session.readyAt ? formatDuration(sessionDuration(session)) : "–"}
        </Fact>
        <Fact label="Time to ready">
          {readyMs === null ? "–" : formatMs(readyMs)}
          {session.startPath && (
            <span
              className={cn(
                "ml-2 rounded px-1.5 py-px align-middle text-[11px] font-medium",
                session.startPath === "hot"
                  ? "bg-primary/12 text-primary"
                  : "bg-info/10 text-info",
              )}
            >
              {session.startPath}
            </span>
          )}
        </Fact>
        <Fact label="Browser time">
          {live ? (
            <span className="text-muted-foreground">at the end</span>
          ) : (
            formatDuration(session.usage.browserSeconds)
          )}
        </Fact>
        <Fact label="Viewport">
          {session.viewport.width}×{session.viewport.height}
          <span className="text-muted-foreground">
            {" "}
            @{session.deviceScaleFactor}x
          </span>
        </Fact>
        <Fact label="Events">{events.length}</Fact>
      </dl>

      <Tabs defaultValue="timeline" className="gap-4">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline">
          <Panel bodyClassName="p-0">
            <Timeline events={events} />
          </Panel>
        </TabsContent>
        <TabsContent value="config">
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Lifecycle">
              <Rows>
                <Row label="Created">
                  {formatDateTime(session.createdAt)} UTC
                </Row>
                <Row label="Ready">{formatDateTime(session.readyAt)}</Row>
                <Row label="Ended">{formatDateTime(session.endedAt)}</Row>
                <Row label="Timeout">{formatDuration(o.timeout / 1000)}</Row>
                <Row label="Idle timeout">
                  {formatDuration(o.idleTimeout / 1000)}
                </Row>
                <Row label="Stop on disconnect">
                  {o.stopOnDisconnect ? "Yes" : "No"}
                </Row>
                <Row label="Recording">{o.recording ? "On" : "Off"}</Row>
              </Rows>
            </Panel>
            <Panel title="Network">
              <Rows>
                <Row label="Proxy">
                  {o.proxy
                    ? `${o.proxy.server}${o.proxy.username ? ` as ${o.proxy.username}` : ""}`
                    : "Direct"}
                </Row>
                <Row label="Allowed hosts">
                  {o.network.allow?.length
                    ? o.network.allow.join(", ")
                    : "Any public host"}
                </Row>
                <Row label="Denied hosts">
                  {o.network.deny?.length ? o.network.deny.join(", ") : "None"}
                </Row>
              </Rows>
            </Panel>
            <Panel title="Metadata" className="lg:col-span-2">
              {Object.keys(o.metadata).length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2 font-mono text-xs">
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
            </Panel>
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1 bg-card px-5 py-4 last:col-span-2 md:last:col-span-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tracking-tight tabular-nums">
        {children}
      </dd>
    </div>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="divide-y text-sm">{children}</dl>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2.5 first:pt-0 last:pb-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{children}</dd>
    </div>
  );
}

const TONE: Record<EventTone, string> = {
  default: "bg-muted text-muted-foreground",
  good: "bg-success/12 text-success",
  warn: "bg-warning/12 text-warning",
  bad: "bg-destructive/12 text-destructive",
};

const ICON: Record<string, LucideIcon> = {
  "session.requested": Sparkles,
  "session.scheduled": Server,
  "session.starting": CirclePlay,
  "session.ready": CirclePlay,
  "session.attached": Link2,
  "session.detached": Link2Off,
  "session.stopping": CircleStop,
  "session.ended": CircleStop,
  "egress.denied": Globe,
  "runtime.crashed": CircleAlert,
  "node.lost": CircleAlert,
  "captcha.detected": ShieldAlert,
  "captcha.cleared": ShieldCheck,
};

function Timeline({ events }: { events: SessionEvent[] }) {
  if (events.length === 0)
    return <p className="p-5 text-sm text-muted-foreground">No events.</p>;
  const t0 = new Date(events[0]!.at).getTime();
  return (
    <ol className="divide-y">
      {events.map((e) => {
        const d = describeEvent(e);
        const Icon = ICON[e.type] ?? Sparkles;
        const offset = (new Date(e.at).getTime() - t0) / 1000;
        return (
          <li
            key={e.id}
            className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-muted/30"
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                TONE[d.tone],
              )}
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                <span className="font-medium">{d.title}</span>
                {d.detail && (
                  <span className="text-muted-foreground"> · {d.detail}</span>
                )}
              </p>
              <p className="font-mono text-[11px] text-muted-foreground/70">
                {e.type}
              </p>
            </div>
            <div className="shrink-0 text-right font-mono text-xs tabular-nums">
              <p className="text-muted-foreground">{formatDateTime(e.at)}</p>
              <p className="text-muted-foreground/60">
                +{formatDuration(offset)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
