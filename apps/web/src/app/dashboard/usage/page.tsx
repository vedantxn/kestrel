import type { Metadata } from "next";
import { UsagePage } from "@kestrel/dashboard/pages/usage";
import { requireClient } from "@/lib/auth";

export const metadata: Metadata = { title: "Usage" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const { client } = await requireClient();
  return (
    <UsagePage
      client={client}
      base="/dashboard"
      searchParams={await searchParams}
    />
  );
}
