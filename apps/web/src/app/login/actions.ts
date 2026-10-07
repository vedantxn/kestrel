"use server";

import { ApiKeySecret } from "@kestrel/contracts";
import { redirect } from "next/navigation";
import {
  KestrelApiError,
  createKestrelClient,
} from "@kestrel/dashboard/lib/client";
import type { LoginState } from "@kestrel/dashboard/components/login-card";
import { API_URL, writeSession } from "@/lib/auth";

/** Check the key against the API, then seal it into the session cookie (T-66). */
export async function signIn(
  _state: LoginState,
  form: FormData,
): Promise<LoginState> {
  const apiKey = String(form.get("apiKey") ?? "").trim();
  if (!ApiKeySecret.safeParse(apiKey).success)
    return { error: "That is not a Kestrel API key. Keys start with ksl_." };
  let project;
  try {
    project = await createKestrelClient({ baseUrl: API_URL, apiKey }).project();
  } catch (e) {
    if (e instanceof KestrelApiError && e.status === 401)
      return { error: "This key is not valid, or it was revoked." };
    return { error: `Could not reach the Kestrel API at ${API_URL}.` };
  }
  await writeSession({ apiKey, projectId: project.id, admin: project.admin });
  redirect("/dashboard");
}
