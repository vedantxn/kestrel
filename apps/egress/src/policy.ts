import { isIPv4, type Socket } from "node:net";
import {
  LIMITS,
  matchesHostPattern,
  type EgressDenyReason,
  type EgressPolicy,
} from "@kestrel/contracts";

/**
 * A session's upstream proxy as the gateway uses it. The password is not kept: only the
 * `Proxy-Authorization` value made from it, which is never listed or logged.
 */
export interface UpstreamEntry {
  host: string;
  /** The host itself when it is an IPv4 literal; otherwise it is resolved per connection. */
  ip: string | null;
  port: number;
  username: string | undefined;
  authorization: string | null;
}

export function toUpstreamEntry(
  u: NonNullable<EgressPolicy["upstream"]>,
): UpstreamEntry {
  return {
    host: u.host,
    ip: isIPv4(u.host) ? u.host : null,
    port: u.port,
    username: u.username,
    authorization:
      u.username === undefined
        ? null
        : "Basic " +
          Buffer.from(`${u.username}:${u.password ?? ""}`, "utf8").toString(
            "base64",
          ),
  };
}

const sameUpstream = (
  a: UpstreamEntry | undefined,
  b: UpstreamEntry | undefined,
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.host === b.host &&
    a.port === b.port &&
    a.authorization === b.authorization);

export interface Entry {
  sessionId: string;
  allow: string[] | undefined;
  deny: string[];
  connectionCap: number;
  /**
   * Connections counted against the cap (N11): reserved before any asynchronous work, so a burst
   * cannot get past it while its requests are still resolving or dialling, and held until the
   * tunnel or request is finished.
   */
  active: number;
  /** Every socket belonging to this policy, so clearing it can cut them at once (G10). */
  sockets: Set<Socket>;
  /** Set: every connection leaves through this proxy, and never directly (T-47). */
  upstream: UpstreamEntry | undefined;
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
    const upstream = p.upstream ? toUpstreamEntry(p.upstream) : undefined;
    // A policy update for the same session through the same exit keeps its connections. A
    // different session at the same address is a different tenant, and a different proxy is a
    // different exit, so the old connections are cut.
    const keep =
      existing !== undefined &&
      existing.sessionId === p.sessionId &&
      sameUpstream(existing.upstream, upstream);
    this.entries.set(ip, {
      sessionId: p.sessionId,
      allow: p.allow,
      deny: p.deny ?? [],
      connectionCap: p.connectionCap ?? LIMITS.egressConnectionCapPerSession,
      active: keep ? existing.active : 0,
      sockets: keep ? existing.sockets : this.cut(existing),
      upstream,
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
    for (const s of e?.sockets ?? []) s.destroy();
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
