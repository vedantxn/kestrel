import type { Metadata } from "next";
import { OverviewPage } from "@kestrel/dashboard/pages/overview";
import { requireClient } from "@/lib/auth";

export const metadata: Metadata = { title: "Overview" };

export default async function Page() {
  const { client } = await requireClient();
  return <OverviewPage client={client} base="/dashboard" />;
}
