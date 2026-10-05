import type { CreatedApiKey } from "@kestrel/contracts";
import {
  KestrelApiError,
  type KestrelClient,
} from "@kestrel/dashboard/lib/client";

/**
 * The mutations the pages need. Each app defines them as server actions ("use server"), built
 * from its own way of getting a client, and passes them to the pages; `dashboardActions` does
 * the work so an app's file is a few one-line wrappers.
 */
export type ActionResult<T = undefined> =
  { ok: true; value: T } | { ok: false; error: string };

export interface DashboardActions {
  stopSession(id: string): Promise<ActionResult>;
  createApiKey(name: string): Promise<ActionResult<CreatedApiKey>>;
  revokeApiKey(id: string): Promise<ActionResult>;
  signOut(): Promise<void>;
}

async function attempt<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    if (e instanceof KestrelApiError) return { ok: false, error: e.message };
    // Next.js signals redirects by throwing; let those through.
    throw e;
  }
}

export function dashboardActions(client: KestrelClient) {
  return {
    stopSession: (id: string) =>
      attempt(async () => {
        await client.stopSession(id);
        return undefined;
      }),
    createApiKey: (name: string) => attempt(() => client.createApiKey(name)),
    revokeApiKey: (id: string) =>
      attempt(async () => {
        await client.revokeApiKey(id);
        return undefined;
      }),
  };
}
