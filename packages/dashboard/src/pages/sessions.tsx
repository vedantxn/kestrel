import { SessionStatus } from "@kestrel/contracts";
import Link from "next/link";
import { AutoRefresh } from "@kestrel/dashboard/components/auto-refresh";
import { PageHeader } from "@kestrel/dashboard/components/page-header";
import { SessionsTable } from "@kestrel/dashboard/components/sessions-table";
import { Button } from "@kestrel/dashboard/components/ui/button";
import type { KestrelClient } from "@kestrel/dashboard/lib/client";
import { Segmented } from "@kestrel/dashboard/components/segmented";

const FILTERS: { label: string; status?: SessionStatus }[] = [
  { label: "All" },
  { label: "Ready", status: "ready" },
  { label: "Active", status: "active" },
  { label: "Stopped", status: "stopped" },
  { label: "Failed", status: "failed" },
  { label: "Timed out", status: "timed_out" },
];

const PAGE = 25;

export async function SessionsPage({
  client,
  base,
  searchParams,
}: {
  client: KestrelClient;
  base: string;
  searchParams: { status?: string | string[]; cursor?: string | string[] };
}) {
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;
  const parsed = SessionStatus.safeParse(one(searchParams.status));
  const status = parsed.success ? parsed.data : undefined;
  const cursor = one(searchParams.cursor);
  const page = await client.listSessions({ status, cursor, limit: PAGE });

  const href = (q: { status?: string; cursor?: string }) => {
    const p = new URLSearchParams();
    if (q.status) p.set("status", q.status);
    if (q.cursor) p.set("cursor", q.cursor);
    const s = p.toString();
    return `${base}/sessions${s ? `?${s}` : ""}`;
  };

  return (
    <>
      {!cursor && <AutoRefresh ms={5000} />}
      <PageHeader
        title="Sessions"
        description="Every browser this project has started, newest first."
      />
      <Segmented
        options={FILTERS.map((f) => ({
          label: f.label,
          value: f.status ?? "",
        }))}
        value={status ?? ""}
        href={(v) => href({ status: v || undefined })}
      />
      <SessionsTable
        sessions={page.data}
        base={base}
        empty={status ? "No sessions with this status." : undefined}
      />
      <div className="flex items-center justify-end gap-2">
        {cursor && (
          <Button asChild variant="outline" size="sm">
            <Link href={href({ status })}>Newest</Link>
          </Button>
        )}
        {page.nextCursor && (
          <Button asChild variant="outline" size="sm">
            <Link href={href({ status, cursor: page.nextCursor })}>Older</Link>
          </Button>
        )}
      </div>
    </>
  );
}
