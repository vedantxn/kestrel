import { CLOSE_CODES, type CONNECT_LIMITS } from "@kestrel/contracts";
import type WebSocket from "ws";
import type { RawData } from "ws";
import type { BufferBudget } from "./budget.js";

export type Limits = { -readonly [K in keyof typeof CONNECT_LIMITS]: number };

export interface RelayOptions {
  limits: Limits;
  budget: BufferBudget;
  /** Poll interval for resuming a paused side. */
  pollMs?: number;
  onBytes?: (direction: "up" | "down", bytes: number) => void;
  onClosed: (clientCode: number) => void;
}

const byteLength = (d: RawData): number =>
  Array.isArray(d)
    ? d.reduce((n, b) => n + b.length, 0)
    : d instanceof ArrayBuffer
      ? d.byteLength
      : d.length;

/** WebSocket close codes that may be sent on the wire; anything else must be mapped. */
function sendable(code: number): number {
  if (
    code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  ) {
    return code;
  }
  return 1011;
}

/**
 * C5, C6. Relays whole messages between a client and its container, in both directions, with
 * compression off and the CDP payload never parsed.
 *
 * Backpressure: if one side's send buffer passes the high mark, the *other* side is paused (its
 * socket stops being read, so TCP pushes back on whoever is sending) until the buffer drains
 * below the low mark. A side paused for too long is closed as too slow (4009). Pings are not
 * counted against a paused side.
 */
export class Relay {
  private closed = false;
  private paused = new Map<WebSocket, number>();
  private pollTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private missed = new Map<WebSocket, number>();

  constructor(
    readonly client: WebSocket,
    readonly upstream: WebSocket,
    private readonly o: RelayOptions,
  ) {}

  start(): void {
    this.pipe(this.client, this.upstream, "up");
    this.pipe(this.upstream, this.client, "down");
    for (const side of [this.client, this.upstream]) {
      this.missed.set(side, 0);
      side.on("pong", () => this.missed.set(side, 0));
      side.on("close", (code) => this.sideClosed(side, code));
      side.on("error", () => this.shutdown(1011, "relay error"));
    }
    this.pingTimer = setInterval(
      () => this.ping(),
      this.o.limits.pingIntervalMs,
    );
    this.pingTimer.unref();
  }

  /** Close both sides, telling the client why. Safe to call more than once. */
  shutdown(clientCode: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    const code = sendable(clientCode);
    // A side we paused cannot complete the close handshake unless we read its reply.
    for (const side of this.paused.keys()) side.resume();
    this.paused.clear();
    try {
      this.client.close(code, reason.slice(0, 120));
    } catch {
      this.client.terminate();
    }
    this.upstream.terminate();
    this.o.onClosed(clientCode);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private stopTimers(): void {
    clearInterval(this.pingTimer);
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private sideClosed(side: WebSocket, code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    if (side === this.client) {
      // The client went away. The session lives on; just let go of our connection to the container.
      this.upstream.terminate();
      this.o.onClosed(code);
    } else {
      // The container side closed. Pass a normal close through; anything abnormal is an error to the client.
      try {
        this.client.close(
          code === 1000
            ? 1000
            : sendable(code === 1006 || code === 1005 ? 1011 : code),
          "browser connection closed",
        );
      } catch {
        this.client.terminate();
      }
      this.o.onClosed(code);
    }
  }

  private pipe(from: WebSocket, to: WebSocket, dir: "up" | "down"): void {
    from.on("message", (data: RawData, isBinary: boolean) => {
      if (this.closed) return;
      const size = byteLength(data);
      if (!this.o.budget.reserve(size)) {
        this.shutdown(
          CLOSE_CODES.limitExceeded,
          "gateway buffer budget exceeded",
        );
        return;
      }
      this.o.onBytes?.(dir, size);
      to.send(data, { binary: isBinary }, (err) => {
        this.o.budget.release(size);
        if (err) this.shutdown(1011, "send failed");
      });
      if (to.bufferedAmount > this.o.limits.pauseAtBufferedBytes)
        this.pause(from, to);
    });
  }

  private pause(from: WebSocket, to: WebSocket): void {
    if (this.paused.has(from)) return;
    from.pause();
    this.paused.set(from, Date.now());
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      for (const [side, since] of this.paused) {
        const target =
          side === from
            ? to
            : side === this.client
              ? this.upstream
              : this.client;
        if (target.bufferedAmount < this.o.limits.resumeAtBufferedBytes) {
          side.resume();
          this.paused.delete(side);
        } else if (Date.now() - since > this.o.limits.maxPausedMs) {
          this.shutdown(CLOSE_CODES.tooSlow, "too slow");
          return;
        }
      }
      if (this.paused.size === 0) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
    }, this.o.pollMs ?? 50);
    this.pollTimer.unref();
  }

  private ping(): void {
    for (const side of [this.client, this.upstream]) {
      if (this.paused.has(side)) continue; // not counted against a side we have stopped reading
      const m = (this.missed.get(side) ?? 0) + 1;
      this.missed.set(side, m);
      if (m > this.o.limits.missedPingsBeforeDrop) {
        this.shutdown(1011, "no response to ping");
        return;
      }
      try {
        side.ping();
      } catch {
        /* closing */
      }
    }
  }
}
