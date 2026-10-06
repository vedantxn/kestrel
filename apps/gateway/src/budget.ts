/**
 * C6, threat model G-03. Counts the bytes currently queued for sending, across every connection
 * and per session. The global limit protects the gateway all sessions share. The per-session
 * share keeps one session from using that limit up and getting another session's connection
 * closed: a session over its share is paused (the relay stops reading the side that sent), and
 * when the global limit is reached, sessions over their share give way first (`Gateway.admit`).
 */
export class BufferBudget {
  private used = 0;
  private bySession = new Map<string, number>();

  constructor(
    readonly limitBytes: number,
    readonly shareBytes: number = limitBytes,
  ) {}

  /** Reserve room for a message about to be queued. False means the global limit would be exceeded, and nothing was reserved. */
  reserve(sessionId: string, bytes: number): boolean {
    if (this.used + bytes > this.limitBytes) return false;
    this.used += bytes;
    this.bySession.set(sessionId, (this.bySession.get(sessionId) ?? 0) + bytes);
    return true;
  }

  release(sessionId: string, bytes: number): void {
    if (bytes <= 0) return;
    this.used = Math.max(0, this.used - bytes);
    const left = (this.bySession.get(sessionId) ?? 0) - bytes;
    if (left > 0) this.bySession.set(sessionId, left);
    else this.bySession.delete(sessionId);
  }

  get usedBytes(): number {
    return this.used;
  }

  sessionBytes(sessionId: string): number {
    return this.bySession.get(sessionId) ?? 0;
  }

  /** The session holds more than its share: stop reading whatever it sends. */
  overShare(sessionId: string): boolean {
    return this.sessionBytes(sessionId) > this.shareBytes;
  }

  /** A session paused for its share is read again once it holds half its share or less. */
  canResume(sessionId: string): boolean {
    return this.sessionBytes(sessionId) <= this.shareBytes / 2;
  }

  /** Sessions holding more than their share, the most first. */
  sessionsOverShare(): string[] {
    return [...this.bySession]
      .filter(([, n]) => n > this.shareBytes)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }

  get largestSessionBytes(): number {
    let max = 0;
    for (const n of this.bySession.values()) max = Math.max(max, n);
    return max;
  }
}

/**
 * G-03. A session's share of the global budget: the configured value if there is one, else the
 * budget divided by the node's slots (every session on a node holds a slot, so the shares add up
 * to the budget), else the contract's default. Never more than the budget itself.
 */
export function sessionShare(o: {
  globalBytes: number;
  defaultBytes: number;
  slots?: number | undefined;
  configuredBytes?: number | undefined;
}): number {
  const share =
    o.configuredBytes ??
    (o.slots && o.slots > 0
      ? Math.floor(o.globalBytes / o.slots)
      : o.defaultBytes);
  return Math.max(1, Math.min(share, o.globalBytes));
}

/** A sliding one-minute count of failures per key, for pre-authentication limits (threat model G-13). */
export class FailureLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if this key is already over its limit. */
  blocked(key: string): boolean {
    const recent = (this.hits.get(key) ?? []).filter(
      (t) => this.now() - t < 60_000,
    );
    this.hits.set(key, recent);
    if (recent.length === 0) this.hits.delete(key);
    return recent.length >= this.perMinute;
  }

  fail(key: string): void {
    const recent = (this.hits.get(key) ?? []).filter(
      (t) => this.now() - t < 60_000,
    );
    recent.push(this.now());
    this.hits.set(key, recent);
  }
}
