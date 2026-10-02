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

/**
 * N14. A session's owner can see why a page did not load, without a page that hammers a blocked
 * address filling the timeline. The first denial for a (session, host, port, reason) is reported
 * at once; further ones in the next window are counted and reported together when it closes. The
 * node agent polls with the last `seq` it saw. `epoch` changes if this process restarts.
 */
export class DenialLog {
  readonly epoch = randomBytes(6).toString("hex");
  private seq = 0;
  private ring: DenialEntry[] = [];
  private windows = new Map<string, Window>();

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
    const key = `${d.sessionId}|${d.host}|${d.port}|${d.reason}`;
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.emit(d, 1 + (w?.pending ?? 0), t);
      this.windows.set(key, { start: t, pending: 0, last: d });
    } else {
      w.pending++;
    }
    if (this.windows.size > 5000) this.sweep(t);
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
    this.sweep(t);
    return this.ring.filter((e) => e.seq > after);
  }

  private sweep(t: number): void {
    for (const [key, w] of this.windows)
      if (w.pending === 0 && t - w.start > 2 * this.windowMs)
        this.windows.delete(key);
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
