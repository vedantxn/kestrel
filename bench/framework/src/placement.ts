import type { Session } from "@kestrel/contracts";
import type { KestrelClient } from "./client.js";
import { agentState, type HostConfig } from "./collect.js";

/** Each node's runtime, as its agent reports it: which collectors, probes and chaos cases apply. */
export async function nodeRuntimes(
  host: HostConfig,
): Promise<Map<string, "docker" | "microvm">> {
  const out = new Map<string, "docker" | "microvm">();
  for (const n of host.nodes) out.set(n.id, (await agentState(n)).runtime);
  return out;
}

/**
 * Sessions on a chosen node. The API places a session itself (most hot browsers, then most free
 * slots), so this creates sessions until enough land on the node, holding the others meanwhile so
 * that capacity shifts towards it, then stops the others.
 */
export async function sessionsOn(
  client: KestrelClient,
  node: string,
  n: number,
  opts: Record<string, unknown> = {},
  maxAttempts = 16,
): Promise<Session[]> {
  const wanted: Session[] = [];
  const others: Session[] = [];
  try {
    for (let i = 0; i < maxAttempts && wanted.length < n; i++) {
      const { session } = await client.create({
        waitForCapacityMs: 20_000,
        ...opts,
      });
      (session.nodeId === node ? wanted : others).push(session);
    }
  } finally {
    for (const s of others) await client.stop(s.id).catch(() => undefined);
  }
  if (wanted.length < n) {
    for (const s of wanted) await client.stop(s.id).catch(() => undefined);
    throw new Error(
      `could not place ${n} session(s) on node ${node} in ${maxAttempts} creates`,
    );
  }
  return wanted;
}
