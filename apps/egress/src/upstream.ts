import type { Socket } from "node:net";

/** An upstream proxy's reply headers may not be larger than this (T-46). */
export const MAX_REPLY_BYTES = 16 * 1024;
const MAX_HEADER_LINES = 100;
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: [^\r\n]*)?$/;
const HEADER_LINE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/;

export type ConnectReply =
  /** 2xx: the tunnel is open; `rest` is whatever the proxy sent after its headers. */
  | { kind: "ok"; rest: Buffer }
  /** 407 Proxy Authentication Required. */
  | { kind: "auth" }
  /** Any other status, or a reply that is malformed or too large. */
  | { kind: "refused" }
  /** The proxy closed or failed before finishing its reply. */
  | { kind: "closed" }
  /** The whole reply did not arrive in time. */
  | { kind: "timeout" };

/** Classify a complete reply head (without its final blank line). */
export function parseConnectReply(head: Buffer, rest: Buffer): ConnectReply {
  const text = head.toString("latin1");
  if (text.includes("\0")) return { kind: "refused" };
  const lines = text.split("\r\n");
  // A bare CR or LF inside a line is how one header is smuggled into another.
  if (lines.some((l) => /[\r\n]/.test(l))) return { kind: "refused" };
  const status = STATUS_LINE.exec(lines[0] ?? "");
  if (!status) return { kind: "refused" };
  const headers = lines.slice(1);
  if (headers.length > MAX_HEADER_LINES) return { kind: "refused" };
  if (!headers.every((l) => HEADER_LINE.test(l))) return { kind: "refused" };
  const code = Number(status[1]);
  if (code >= 200 && code <= 299) return { kind: "ok", rest };
  if (code === 407) return { kind: "auth" };
  return { kind: "refused" };
}

/**
 * Read an upstream proxy's reply to CONNECT. The proxy is chosen by a caller and treated as
 * hostile (T-46): one deadline for the whole reply, so a trickle cannot hold it open; a size
 * limit; a strict grammar. On return the socket is paused with no data listener, ready to be
 * piped, and keeps a no-op error listener so a late error cannot crash the process.
 */
export function readConnectReply(
  sock: Socket,
  timeoutMs: number,
): Promise<ConnectReply> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (r: ConnectReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("end", onClosed);
      sock.off("close", onClosed);
      sock.pause();
      resolve(r);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buf.length > MAX_REPLY_BYTES) finish({ kind: "refused" });
        return;
      }
      if (end + 4 > MAX_REPLY_BYTES) return finish({ kind: "refused" });
      finish(parseConnectReply(buf.subarray(0, end), buf.subarray(end + 4)));
    };
    const onClosed = (): void => finish({ kind: "closed" });
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    sock.on("error", () => onClosed());
    sock.on("data", onData);
    sock.once("end", onClosed);
    sock.once("close", onClosed);
    if (sock.destroyed) onClosed();
  });
}
