import { isIPv4, type Socket } from "node:net";
import {
  LIMITS,
  matchesHostPattern,
  type EgressDenyReason,
  type EgressPolicy,
} from "@kestrel/contracts";

/**
 * A session's upstream proxy as the gateway uses it. For HTTP and HTTPS proxies the password is
 * not kept, only the `Proxy-Authorization` value made from it; SOCKS5 sends the username and
 * password themselves (RFC 1929), so for a SOCKS5 proxy they are kept, in memory only. Neither
 * is ever listed or logged.
 */
export interface UpstreamEntry {
  scheme: "http" | "https" | "socks5";
  host: string;
  /** The host itself when it is an IPv4 literal; otherwise it is resolved per connection. */
  ip: string | null;
  port: number;
  username: string | undefined;
  authorization: string | null;
  /** SOCKS5 only. */
  socksCredentials: { username: string; password: string } | null;
}

export function toUpstreamEntry(
  u: NonNullable<EgressPolicy["upstream"]>,
): UpstreamEntry {
  const scheme = u.scheme ?? "http";
  return {
    scheme,
    host: u.host,
    ip: isIPv4(u.host) ? u.host : null,
    port: u.port,
    username: u.username,
    authorization:
      u.username === undefined || scheme === "socks5"
        ? null
        : "Basic " +
          Buffer.from(`${u.username}:${u.password ?? ""}`, "utf8").toString(
            "base64",
          ),
    socksCredentials:
      scheme === "socks5" && u.username !== undefined
        ? { username: u.username, password: u.password ?? "" }
        : null,
  };
}

const sameUpstream = (
  a: UpstreamEntry | undefined,
  b: UpstreamEntry | undefined,
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.scheme === b.scheme &&
    a.host === b.host &&
    a.port === b.port &&
    a.authorization === b.authorization &&
    a.socksCredentials?.username === b.socksCredentials?.username &&
    a.socksCredentials?.password === b.socksCredentials?.password);

/** Bytes relayed for a session (threat model G-20), counted at the browser's side of the gateway. */
export interface ByteCounter {
  /** From the browser. */
  up: number;
  /** To the browser. */
  down: number;
}

/** Add to a counter, saturating where JSON numbers stop being exact. */
export function countBytes(
  c: ByteCounter,
  dir: "up" | "down",
  n: number,
): void {
  c[dir] = Math.min(Number.MAX_SAFE_INTEGER, c[dir] + n);
}

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
  /** Kept across policy updates for the same session; reported and forgotten when it is cleared. */
  bytes: ByteCounter;
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
    // different exit, so the old connections are cut. The session's byte counts carry over.
    const same = existing !== undefined && existing.sessionId === p.sessionId;
    const keep = same && sameUpstream(existing.upstream, upstream);
    this.entries.set(ip, {
      sessionId: p.sessionId,
      allow: p.allow,
      deny: p.deny ?? [],
      connectionCap: p.connectionCap ?? LIMITS.egressConnectionCapPerSession,
      active: keep ? existing.active : 0,
      sockets: keep ? existing.sockets : this.cut(existing),
      upstream,
      bytes: same ? existing.bytes : { up: 0, down: 0 },
    });
  }

  /**
   * Clear a policy and cut its open tunnels at once: an address is never free while it still has
   * a way out (G10). Returns the cleared session and its final byte counts, or null.
   */
  delete(ip: string): { sessionId: string; bytes: ByteCounter } | null {
    const e = this.entries.get(ip);
    if (!e) return null;
    this.cut(e);
    this.entries.delete(ip);
    return { sessionId: e.sessionId, bytes: { ...e.bytes } };
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
