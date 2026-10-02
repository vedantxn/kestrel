/**
 * C6. One session must not be able to exhaust the gateway all sessions share. This counts the
 * bytes currently queued for sending across every connection. A connection that would push the
 * total over the budget is closed instead.
 */
export class BufferBudget {
  private used = 0;

  constructor(readonly limitBytes: number) {}

  /** Reserve room for a message about to be queued. False means the budget would be exceeded. */
  reserve(bytes: number): boolean {
    if (this.used + bytes > this.limitBytes) return false;
    this.used += bytes;
    return true;
  }

  release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }

  get usedBytes(): number {
    return this.used;
  }
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
