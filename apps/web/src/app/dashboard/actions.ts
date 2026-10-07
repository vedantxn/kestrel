"use server";

import { redirect } from "next/navigation";
import { dashboardActions } from "@kestrel/dashboard/lib/actions";
import { clearSession, requireClient } from "@/lib/auth";

/** The dashboard's mutations (T-67: server actions refuse a foreign Origin). */
const actions = async () => dashboardActions((await requireClient()).client);

export async function stopSession(id: string) {
  return (await actions()).stopSession(id);
}

export async function createApiKey(name: string) {
  return (await actions()).createApiKey(name);
}

export async function revokeApiKey(id: string) {
  return (await actions()).revokeApiKey(id);
}

export async function signOut() {
  await clearSession();
  redirect("/login");
}
