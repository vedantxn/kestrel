import {
  CreateKeyDialog,
  RevokeKeyButton,
} from "@kestrel/dashboard/components/api-key-dialogs";
import { PageHeader } from "@kestrel/dashboard/components/page-header";
import { Badge } from "@kestrel/dashboard/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@kestrel/dashboard/components/ui/table";
import type { DashboardActions } from "@kestrel/dashboard/lib/actions";
import type { KestrelClient } from "@kestrel/dashboard/lib/client";
import { formatDateTime, timeAgo } from "@kestrel/dashboard/lib/format";
import { cn } from "@kestrel/dashboard/lib/utils";

export async function ApiKeysPage({
  client,
  actions,
  hideNames = [],
  currentPrefix,
}: {
  client: KestrelClient;
  actions: Pick<DashboardActions, "createApiKey" | "revokeApiKey">;
  /** Keys an app manages itself and does not offer to revoke (the hosted app's own key). */
  hideNames?: string[];
  /** The prefix of the key this dashboard session uses; it cannot revoke itself. */
  currentPrefix?: string;
}) {
  const { data } = await client.listApiKeys();
  const keys = data.filter((k) => !hideNames.includes(k.name));
  const active = keys.filter((k) => !k.revokedAt).length;

  return (
    <>
      <PageHeader
        title="API keys"
        description={`${active} active. A key has full access to this project's sessions; keep it out of browsers and repositories.`}
        actions={<CreateKeyDialog create={actions.createApiKey} />}
      />
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead className="hidden md:table-cell">Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => (
              <TableRow
                key={k.id}
                className={cn(k.revokedAt && "text-muted-foreground")}
              >
                <TableCell className="font-medium">
                  {k.name}
                  {k.admin && (
                    <Badge variant="outline" className="ml-2">
                      admin
                    </Badge>
                  )}
                  {!k.revokedAt && k.prefix === currentPrefix && (
                    <Badge variant="secondary" className="ml-2">
                      this key
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{k.prefix}…</TableCell>
                <TableCell className="hidden whitespace-nowrap md:table-cell">
                  {formatDateTime(k.createdAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {k.lastUsedAt ? timeAgo(k.lastUsedAt) : "Never"}
                </TableCell>
                <TableCell>
                  {k.revokedAt ? (
                    <Badge variant="secondary">
                      Revoked {timeAgo(k.revokedAt)}
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
                <TableCell className="text-right">
                  {!k.revokedAt && k.prefix !== currentPrefix && (
                    <RevokeKeyButton
                      id={k.id}
                      name={k.name}
                      revoke={actions.revokeApiKey}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        The key you signed in with cannot be revoked from here. Admin keys are
        made only on the host, with{" "}
        <code className="font-mono">admin create-key --admin</code>.
      </p>
    </>
  );
}
