import type { ReactNode } from "react";
import { Shell } from "@kestrel/dashboard/components/shell";
import { requireClient } from "@/lib/auth";
import { signOut } from "./actions";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { client } = await requireClient();
  const project = await client.project();
  return (
    <Shell
      project={project.name}
      org={project.org.name}
      admin={project.admin}
      signOut={signOut}
    >
      {children}
    </Shell>
  );
}
