import type { Metadata } from "next";
import { NodesPage } from "@kestrel/dashboard/pages/nodes";
import { requireClient } from "@/lib/auth";

export const metadata: Metadata = { title: "Nodes" };

export default async function Page() {
  const { client } = await requireClient();
  return <NodesPage client={client} />;
}
