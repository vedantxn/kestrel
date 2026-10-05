import type { Metadata } from "next";
import { SettingsPage } from "@kestrel/dashboard/pages/settings";
import { PUBLIC_API_URL, requireClient } from "@/lib/auth";
import { signOut } from "../actions";

export const metadata: Metadata = { title: "Settings" };

export default async function Page() {
  const { client } = await requireClient();
  return (
    <SettingsPage
      client={client}
      apiUrl={PUBLIC_API_URL}
      actions={{ signOut }}
    />
  );
}
