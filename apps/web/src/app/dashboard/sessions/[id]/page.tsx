import type { Metadata } from "next";
import { SessionDetailPage } from "@kestrel/dashboard/pages/session-detail";
import { requireClient } from "@/lib/auth";
import { stopSession } from "../../actions";

export const metadata: Metadata = { title: "Session" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { client } = await requireClient();
  return (
    <SessionDetailPage
      client={client}
      base="/dashboard"
      id={(await params).id}
      actions={{ stopSession }}
    />
  );
}
