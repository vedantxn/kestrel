import type { Metadata } from "next";
import { SessionsPage } from "@kestrel/dashboard/pages/sessions";
import { requireClient } from "@/lib/auth";

export const metadata: Metadata = { title: "Sessions" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const { client } = await requireClient();
  return (
    <SessionsPage
      client={client}
      base="/dashboard"
      searchParams={await searchParams}
    />
  );
}
