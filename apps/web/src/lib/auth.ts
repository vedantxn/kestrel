import "server-only";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createKestrelClient,
  type KestrelClient,
} from "@kestrel/dashboard/lib/client";
import {
  SESSION_COOKIE,
  SESSION_TTL_S,
  openSession,
  sealSession,
  sessionKey,
  type WebSession,
} from "./session";

/** Where the dashboard's server reaches the API's public listener. */
export const API_URL = (
  process.env.KESTREL_API_URL ?? "http://127.0.0.1:8080"
).replace(/\/+$/, "");

/** What people paste into their SDK; the dashboard may reach the API by another address. */
export const PUBLIC_API_URL = (
  process.env.KESTREL_PUBLIC_API_URL ?? API_URL
).replace(/\/+$/, "");

let key: Uint8Array | undefined;

/** Secrets are files (G-09): WEB_SESSION_SECRET_FILE, or WEB_SESSION_SECRET in development. */
function secretKey(): Uint8Array {
  if (key) return key;
  const file = process.env.WEB_SESSION_SECRET_FILE;
  let secret = file
    ? readFileSync(file, "utf8").trim()
    : process.env.WEB_SESSION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production")
      throw new Error("WEB_SESSION_SECRET_FILE is required");
    // Development only: sign-ins last until the server restarts.
    secret = randomBytes(32).toString("hex");
  }
  key = sessionKey(secret);
  return key;
}

export async function readSession(): Promise<WebSession | null> {
  const jar = await cookies();
  return openSession(jar.get(SESSION_COOKIE)?.value, secretKey());
}

export async function writeSession(s: WebSession): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, await sealSession(s, secretKey()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export function clientFor(apiKey: string): KestrelClient {
  return createKestrelClient({
    baseUrl: API_URL,
    apiKey,
    onUnauthorized: () => redirect("/login?expired=1"),
  });
}

/** The signed-in person's client, or a redirect to sign-in. */
export async function requireClient(): Promise<{
  client: KestrelClient;
  session: WebSession;
}> {
  const session = await readSession();
  if (!session) redirect("/login");
  return { client: clientFor(session.apiKey), session };
}
