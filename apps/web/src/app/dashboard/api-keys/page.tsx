import type { Metadata } from "next";
import { ApiKeysPage } from "@kestrel/dashboard/pages/api-keys";
import { requireClient } from "@/lib/auth";
import { createApiKey, revokeApiKey } from "../actions";

export const metadata: Metadata = { title: "API keys" };

export default async function Page() {
  const { client, session } = await requireClient();
  return (
    <ApiKeysPage
      client={client}
      actions={{ createApiKey, revokeApiKey }}
      currentPrefix={session.apiKey.slice(0, 8)}
    />
  );
}
