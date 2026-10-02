import type { Socket } from "node:net";
import {
  LIMITS,
  matchesHostPattern,
  type EgressDenyReason,
  type EgressPolicy,
} from "@kestrel/contracts";

export interface Entry {
  sessionId: string;
  allow: string[] | undefined;
  deny: string[];
  connectionCap: number;
  open: Set<Socket>;
}

/**
 * C7, N6. Policy is keyed by the container's source address on the session network. An address
 * with no policy is refused entirely: pooled containers, a container whose policy has been
 * cleared, and anything unexpected get nothing. A new process starts empty and refuses
 * everything until the node agent restores the policies (N13), so a restart fails closed.
 */
export class PolicyStore {
  private entries = new Map<string, Entry>();
  /** False after a start, until the agent says it has pushed everything. */
  restored = false;

  get size(): number {
    return this.entries.size;
  }

  set(ip: string, p: EgressPolicy): void {
    const existing = this.entries.get(ip);
    this.entries.set(ip, {
      sessionId: p.sessionId,
      allow: p.allow,
      deny: p.deny ?? [],
      connectionCap: p.connectionCap ?? LIMITS.egressConnectionCapPerSession,
      // A policy update for the same session keeps its open tunnels; a different session at the
      // same address is a different tenant, so the old one's tunnels are cut.
      open:
        existing && existing.sessionId === p.sessionId
          ? existing.open
          : this.cut(existing),
    });
  }

  /** Clear a policy and cut its open tunnels at once: an address is never free while it still has a way out (G10). */
  delete(ip: string): boolean {
    const e = this.entries.get(ip);
    if (!e) return false;
    this.cut(e);
    return this.entries.delete(ip);
  }

  private cut(e: Entry | undefined): Set<Socket> {
    for (const s of e?.open ?? []) s.destroy();
    return new Set();
  }

  get(ip: string): Entry | undefined {
    return this.entries.get(ip);
  }

  list(): { ip: string; entry: Entry }[] {
    return [...this.entries].map(([ip, entry]) => ({ ip, entry }));
  }
}

/**
 * N10. Decide by hostname, before any resolution. A deny entry always wins; if an allow list is
 * present, only names matching it pass. A bare IP address never matches a hostname pattern, so
 * with an allow list present it is refused.
 */
export function listDecision(
  entry: Entry,
  host: string,
  isIp: boolean,
): EgressDenyReason | null {
  if (!isIp && entry.deny.some((p) => matchesHostPattern(p, host)))
    return "in_deny_list";
  if (
    entry.allow &&
    (isIp || !entry.allow.some((p) => matchesHostPattern(p, host)))
  )
    return "not_in_allow_list";
  return null;
}
