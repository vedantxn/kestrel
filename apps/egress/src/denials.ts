import { randomBytes } from "node:crypto";
import type { EgressDenyReason } from "@kestrel/contracts";

export interface DenialEntry {
  seq: number;
  sessionId: string;
  host: string;
  port: number;
  reason: EgressDenyReason;
  count: number;
  at: number;
}

interface Window {
  start: number;
  pending: number;
  last: Omit<DenialEntry, "seq" | "count" | "at">;
}

/** A session may produce this many distinct entries per window; the rest are counted under one summary. */
const DISTINCT_PER_SESSION = 20;
const MAX_WINDOWS = 5000;

/**
 * N14. A session's owner can see why a page did not load, without a page that hammers a blocked
 * address filling the timeline. The first denial for a (session, host, port, reason) is reported
 * at once; further ones in the next window are counted and reported together when it closes. The
 * node agent polls with the last `seq` it saw. `epoch` changes if this process restarts.
 *
 * The hostnames are chosen by a hostile page, so the log is bounded against it: one session gets a
 * fixed number of distinct entries per window (more are folded into a single `*` entry), the table
 * of windows has a ceiling, and cleaning up runs on a timer rather than on every denial. One
 * session therefore cannot push another's events out of the ring or slow the proxy down.
 */
export class DenialLog {
  readonly epoch = randomBytes(6).toString("hex");
  private seq = 0;
  private ring: DenialEntry[] = [];
  private windows = new Map<string, Window>();
  private budget = new Map<string, { start: number; used: number }>();
  private lastSweep = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 10_000,
    private readonly capacity = 1000,
  ) {}

  add(d: {
    sessionId: string;
    host: string;
    port: number;
    reason: EgressDenyReason;
  }): void {
    const t = this.now();
    let key = `${d.sessionId}|${d.host}|${d.port}|${d.reason}`;
    let entry = d;
    let w = this.windows.get(key);
    if (!w) {
      // A new distinct entry: only within this session's budget, and while there is room in the table.
      const b = this.budget.get(d.sessionId);
      const fresh = !b || t - b.start >= this.windowMs;
      const used = fresh ? 0 : (b as { used: number }).used;
      if (used >= DISTINCT_PER_SESSION || this.windows.size >= MAX_WINDOWS) {
        entry = { ...d, host: "*", port: 0 };
        key = `${d.sessionId}|*|0|${d.reason}`;
        w = this.windows.get(key);
      } else {
        this.budget.set(d.sessionId, {
          start: fresh ? t : (b as { start: number }).start,
          used: used + 1,
        });
      }
    }
    if (!w || t - w.start >= this.windowMs) {
      this.emit(entry, 1 + (w?.pending ?? 0), t);
      this.windows.set(key, { start: t, pending: 0, last: entry });
    } else {
      w.pending++;
    }
    this.sweep(t);
  }

  /** Entries after `seq`, closing any windows that have ended. */
  read(after: number): DenialEntry[] {
    const t = this.now();
    for (const w of this.windows.values()) {
      if (t - w.start >= this.windowMs && w.pending > 0) {
        this.emit(w.last, w.pending, t);
        w.pending = 0;
        w.start = t;
      }
    }
    this.sweep(t, true);
    return this.ring.filter((e) => e.seq > after);
  }

  private sweep(t: number, force = false): void {
    if (!force && t - this.lastSweep < 1000) return;
    this.lastSweep = t;
    for (const [key, w] of this.windows)
      if (w.pending === 0 && t - w.start > 2 * this.windowMs)
        this.windows.delete(key);
    for (const [id, b] of this.budget)
      if (t - b.start > 2 * this.windowMs) this.budget.delete(id);
  }

  private emit(
    d: Omit<DenialEntry, "seq" | "count" | "at">,
    count: number,
    at: number,
  ): void {
    this.ring.push({
      seq: ++this.seq,
      sessionId: d.sessionId,
      host: d.host,
      port: d.port,
      reason: d.reason,
      count,
      at,
    });
    if (this.ring.length > this.capacity) this.ring.shift();
  }
}
