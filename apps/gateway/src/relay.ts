import { CLOSE_CODES, type CONNECT_LIMITS } from "@kestrel/contracts";
import type WebSocket from "ws";
import type { RawData } from "ws";
import type { BufferBudget } from "./budget.js";

export type Limits = { -readonly [K in keyof typeof CONNECT_LIMITS]: number };

export interface RelayOptions {
  limits: Limits;
  /** The session this connection belongs to: its share of the budget is counted across all its connections (G-03). */
  sessionId: string;
  budget: BufferBudget;
  /**
   * Make room in the budget for a message about to be queued, charged to this session. It may
   * close other sessions' connections to do so (`Gateway.admit`). False: this connection is closed.
   * Without it, the budget's global limit alone decides.
   */
  admit?: (bytes: number) => boolean;
  /** Poll interval for resuming a paused side. */
  pollMs?: number;
  onBytes?: (direction: "up" | "down", bytes: number) => void;
  /** A side stopped being read: its peer's buffer is full, or its session is over its share. */
  onPause?: (reason: PauseReason) => void;
  onClosed: (clientCode: number) => void;
}

export type PauseReason = "buffer" | "share";
type Direction = "up" | "down";

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
 * C5, C6, G-03. Relays whole messages between a client and its container, in both directions, with
 * compression off and the CDP payload never parsed.
 *
 * Backpressure: if one side's send buffer passes the high mark, the *other* side is paused (its
 * socket stops being read, so TCP pushes back on whoever is sending) until the buffer drains
 * below the low mark. The same happens when the whole session holds more than its share of the
 * gateway's budget (G-03): the side that sent is paused until the session is back to half its
 * share. A side paused for too long is closed as too slow (4009). Pings are not counted against
 * a paused side.
 */
export class Relay {
  private closed = false;
  private paused = new Map<WebSocket, { since: number; share: boolean }>();
  /** Bytes this relay has charged to the budget and not yet released, by the direction they travel. */
  private queued: Record<Direction, number> = { up: 0, down: 0 };
  /** A direction whose socket has been torn down: its charge was released at once, so late callbacks release nothing. */
  private dropped: Record<Direction, boolean> = { up: false, down: false };
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

  /**
   * Close both sides, telling the client why. Safe to call more than once. With `drop`, the
   * client is cut rather than closed, so what is queued for it is freed at once: for a client
   * that is not reading, a close code would sit behind that data anyway.
   */
  shutdown(clientCode: number, reason: string, drop = false): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    const code = sendable(clientCode);
    // A side we paused cannot complete the close handshake unless we read its reply.
    for (const side of this.paused.keys()) side.resume();
    this.paused.clear();
    if (drop) {
      this.client.terminate();
      this.releaseQueued("down");
    } else {
      try {
        this.client.close(code, reason.slice(0, 120));
      } catch {
        this.client.terminate();
      }
    }
    this.upstream.terminate();
    this.releaseQueued("up");
    this.o.onClosed(clientCode);
  }

  /**
   * G-03: closed so another session can have budget. Whatever this connection holds is released
   * now, and the client is dropped if it has data still waiting for it.
   */
  evict(): void {
    this.shutdown(
      CLOSE_CODES.limitExceeded,
      "gateway buffer budget: session over its share",
      this.client.bufferedAmount > 0,
    );
    this.releaseQueued("down");
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Bytes this connection holds in the budget. */
  get queuedBytes(): number {
    return this.queued.up + this.queued.down;
  }

  private releaseQueued(dir: Direction): void {
    if (this.dropped[dir]) return;
    this.dropped[dir] = true;
    this.o.budget.release(this.o.sessionId, this.queued[dir]);
    this.queued[dir] = 0;
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
    for (const side of this.paused.keys()) side.resume();
    this.paused.clear();
    if (side === this.client) {
      // The client went away. The session lives on; just let go of our connection to the container.
      this.upstream.terminate();
      this.releaseQueued("up");
      this.releaseQueued("down");
      this.o.onClosed(code);
    } else {
      this.releaseQueued("up");
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

  private pipe(from: WebSocket, to: WebSocket, dir: Direction): void {
    const session = this.o.sessionId;
    from.on("message", (data: RawData, isBinary: boolean) => {
      if (this.closed) return;
      const size = byteLength(data);
      const admitted = this.o.admit
        ? this.o.admit(size)
        : this.o.budget.reserve(session, size);
      if (!admitted) {
        this.shutdown(
          CLOSE_CODES.limitExceeded,
          "gateway buffer budget exceeded",
        );
        return;
      }
      this.queued[dir] += size;
      this.o.onBytes?.(dir, size);
      to.send(data, { binary: isBinary }, (err) => {
        if (!this.dropped[dir]) {
          this.queued[dir] -= size;
          this.o.budget.release(session, size);
        }
        if (err) this.shutdown(1011, "send failed");
      });
      if (to.bufferedAmount > this.o.limits.pauseAtBufferedBytes)
        this.pause(from, "buffer");
      else if (this.o.budget.overShare(session)) this.pause(from, "share");
    });
  }

  private pause(from: WebSocket, reason: PauseReason): void {
    const already = this.paused.get(from);
    if (already) {
      if (reason === "share") already.share = true;
      return;
    }
    from.pause();
    this.paused.set(from, { since: Date.now(), share: reason === "share" });
    this.o.onPause?.(reason);
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      for (const [side, p] of this.paused) {
        const target = side === this.client ? this.upstream : this.client;
        const drained =
          target.bufferedAmount < this.o.limits.resumeAtBufferedBytes &&
          (!p.share || this.o.budget.canResume(this.o.sessionId));
        if (drained) {
          side.resume();
          this.paused.delete(side);
        } else if (Date.now() - p.since > this.o.limits.maxPausedMs) {
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
