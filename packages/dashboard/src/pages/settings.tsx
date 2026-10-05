import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "@kestrel/dashboard/components/copy-button";
import { PageHeader } from "@kestrel/dashboard/components/page-header";
import { Button } from "@kestrel/dashboard/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@kestrel/dashboard/components/ui/card";
import type { DashboardActions } from "@kestrel/dashboard/lib/actions";
import type { KestrelClient } from "@kestrel/dashboard/lib/client";
import { formatDateTime } from "@kestrel/dashboard/lib/format";

export async function SettingsPage({
  client,
  apiUrl,
  actions,
  children,
}: {
  client: KestrelClient;
  /** The API's public URL, for the snippet. */
  apiUrl: string;
  actions: Pick<DashboardActions, "signOut">;
  /** More sections an app adds (the hosted app's members). */
  children?: ReactNode;
}) {
  const p = await client.project();
  const snippet = `import { Kestrel } from "@kestrel/sdk";

const kestrel = new Kestrel({
  apiKey: process.env.KESTREL_API_KEY,
  baseUrl: "${apiUrl}",
});
const { browser, close } = await kestrel.connect();`;

  return (
    <>
      <PageHeader
        title="Settings"
        description="This project and how to reach it."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Project</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Name">{p.name}</Row>
            <Row label="Project id" copy={p.id}>
              <span className="font-mono text-xs">{p.id}</span>
            </Row>
            <Row label="Organisation">{p.org.name}</Row>
            <Row label="Organisation id" copy={p.org.id}>
              <span className="font-mono text-xs">{p.org.id}</span>
            </Row>
            <Row label="Created">{formatDateTime(p.createdAt)} UTC</Row>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Limits</CardTitle>
            <CardDescription>
              Changed by the operator. Over a limit, creates answer 429.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Live sessions at once">
              {p.quotas.maxConcurrentSessions}
            </Row>
            <Row label="Session creates per minute">
              {p.quotas.createsPerMinute}
            </Row>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Connect</CardTitle>
            <CardDescription>
              The API is at <span className="font-mono">{apiUrl}</span>. Use a
              key from API keys.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative rounded-lg border bg-muted/40">
              <div className="absolute top-2 right-2">
                <CopyButton value={snippet} label="Copy snippet" />
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed">
                {snippet}
              </pre>
            </div>
          </CardContent>
        </Card>
        {children}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Session</CardTitle>
            <CardDescription>
              {p.admin
                ? "Signed in with an admin key."
                : "Signed in with a project key."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={actions.signOut}>
              <Button variant="outline" size="sm" type="submit">
                <LogOut /> Sign out
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({
  label,
  children,
  copy,
}: {
  label: string;
  children: ReactNode;
  copy?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-dashed pb-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-right">
        <span className="truncate">{children}</span>
        {copy && <CopyButton value={copy} />}
      </span>
    </div>
  );
}
