import type { Clock } from "@kestrel/shared";

/**
 * A14: session creations per minute per project, held in memory (one API process in v1).
 * A sliding window of timestamps; `check` records the attempt if it is allowed.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {}

  /** Returns 0 if allowed, otherwise the seconds until it would be. */
  check(key: string, limitPerMinute: number): number {
    const now = this.clock.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limitPerMinute) {
      this.hits.set(key, recent);
      return Math.max(
        1,
        Math.ceil((60_000 - (now - (recent[0] as number))) / 1000),
      );
    }
    recent.push(now);
    this.hits.set(key, recent);
    return 0;
  }
}
