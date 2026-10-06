import { isIPv4, type Socket } from "node:net";

/**
 * A SOCKS5 client handshake (RFC 1928, with RFC 1929 username and password authentication),
 * spoken to a session's upstream proxy. The proxy is chosen by a caller and is hostile (T-46):
 * the whole handshake has one deadline, every reply has a fixed or bounded size, and anything
 * that does not follow the grammar is refused. The destination is sent by name (address type
 * 3), so the proxy resolves it from its own network and the host never looks it up.
 */

/** No SOCKS5 reply is longer: 4 header bytes, a 1-byte length and 255 name bytes, and a port. */
export const MAX_SOCKS_REPLY_BYTES = 4 + 1 + 255 + 2;

export type SocksResult =
  /** The tunnel is open; `rest` is whatever the proxy sent after its reply. */
  | { kind: "ok"; rest: Buffer }
  /** No acceptable method (the proxy wants credentials we lack), or the credentials were refused. */
  | { kind: "auth" }
  /** A failure reply (`code`, RFC 1928 section 6), or a reply that breaks the grammar. */
  | { kind: "refused"; code?: number }
  /** The proxy closed or failed before finishing its reply. */
  | { kind: "closed" }
  /** The handshake did not finish in time. */
  | { kind: "timeout" };

export interface SocksRequest {
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
}

class Stop extends Error {
  constructor(readonly result: SocksResult) {
    super(result.kind);
  }
}

/**
 * Bytes from the socket on demand, under one deadline and a size limit for everything read.
 * On `finish` the socket is paused with no data listener, ready to be piped, and keeps a
 * no-op error listener so a late error cannot crash the process.
 */
class Reader {
  private buf = Buffer.alloc(0);
  private total = 0;
  private waiter: {
    n: number;
    resolve: (b: Buffer) => void;
    reject: (e: Stop) => void;
  } | null = null;
  private ended: SocksResult | null = null;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly sock: Socket,
    timeoutMs: number,
    private readonly limit: number,
  ) {
    this.timer = setTimeout(() => this.end({ kind: "timeout" }), timeoutMs);
    sock.on("error", this.onClosed);
    sock.on("data", this.onData);
    sock.once("end", this.onClosed);
    sock.once("close", this.onClosed);
    if (sock.destroyed) this.onClosed();
  }

  private onData = (chunk: Buffer): void => {
    this.total += chunk.length;
    if (this.total > this.limit) return this.end({ kind: "refused" });
    this.buf = Buffer.concat([this.buf, chunk]);
    this.pump();
  };
  private onClosed = (): void => this.end({ kind: "closed" });

  private end(r: SocksResult): void {
    if (this.ended) return;
    this.ended = r;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(new Stop(r));
  }

  private pump(): void {
    const w = this.waiter;
    if (!w || this.buf.length < w.n) return;
    this.waiter = null;
    const out = this.buf.subarray(0, w.n);
    this.buf = this.buf.subarray(w.n);
    w.resolve(out);
  }

  read(n: number): Promise<Buffer> {
    if (this.ended && this.buf.length < n)
      return Promise.reject(new Stop(this.ended));
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.pump();
    });
  }

  /** Stop reading. Returns what arrived beyond the reply. */
  finish(): Buffer {
    clearTimeout(this.timer);
    this.sock.off("data", this.onData);
    this.sock.off("end", this.onClosed);
    this.sock.off("close", this.onClosed);
    this.sock.off("error", this.onClosed);
    this.sock.on("error", () => undefined);
    this.sock.pause();
    return this.buf;
  }
}

/** The CONNECT request's address: IPv4 literals as type 1, names as type 3 (resolved by the proxy). */
function address(host: string): Buffer {
  if (isIPv4(host))
    return Buffer.from([0x01, ...host.split(".").map((o) => Number(o))]);
  const name = Buffer.from(host, "ascii");
  if (name.length < 1 || name.length > 255) throw new Error("bad host");
  return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

/**
 * Ask a SOCKS5 proxy, already connected on `sock`, for a tunnel to `req.host:req.port`.
 * Credentials are offered only when given (RFC 1929); without them only "no authentication".
 */
export async function socksConnect(
  sock: Socket,
  req: SocksRequest,
  timeoutMs: number,
): Promise<SocksResult> {
  const reader = new Reader(sock, timeoutMs, 2 + 2 + MAX_SOCKS_REPLY_BYTES);
  try {
    const withCreds = req.username !== undefined;
    // Greeting: version 5 and the methods offered (0 none, 2 username and password).
    sock.write(
      Buffer.from(withCreds ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]),
    );
    const choice = await reader.read(2);
    if (choice[0] !== 0x05) return stop(reader, { kind: "refused" });
    const method = choice[1];
    if (method === 0xff) return stop(reader, { kind: "auth" });
    if (method === 0x02 && withCreds) {
      const u = Buffer.from(req.username as string, "utf8");
      const p = Buffer.from(req.password ?? "", "utf8");
      if (u.length > 255 || p.length > 255)
        return stop(reader, { kind: "auth" });
      sock.write(
        Buffer.concat([
          Buffer.from([0x01, u.length]),
          u,
          Buffer.from([p.length]),
          p,
        ]),
      );
      const status = await reader.read(2);
      // RFC 1929 says version 1; some servers answer 5. Anything else is not this protocol.
      if (status[0] !== 0x01 && status[0] !== 0x05)
        return stop(reader, { kind: "refused" });
      if (status[1] !== 0x00) return stop(reader, { kind: "auth" });
    } else if (method !== 0x00) {
      // A method we did not offer.
      return stop(reader, { kind: "refused" });
    }

    const port = Buffer.alloc(2);
    port.writeUInt16BE(req.port);
    sock.write(
      Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address(req.host), port]),
    );
    const head = await reader.read(4);
    if (head[0] !== 0x05 || head[2] !== 0x00)
      return stop(reader, { kind: "refused" });
    if (head[1] !== 0x00)
      return stop(reader, { kind: "refused", code: head[1] as number });
    const atyp = head[3];
    let addrLen: number;
    if (atyp === 0x01) addrLen = 4;
    else if (atyp === 0x04) addrLen = 16;
    else if (atyp === 0x03) addrLen = (await reader.read(1))[0] as number;
    else return stop(reader, { kind: "refused" });
    await reader.read(addrLen + 2); // the bound address and port: not used
    return { kind: "ok", rest: reader.finish() };
  } catch (e) {
    if (e instanceof Stop) {
      reader.finish();
      return e.result;
    }
    reader.finish();
    return { kind: "refused" };
  }
}

function stop(reader: Reader, r: SocksResult): SocksResult {
  reader.finish();
  return r;
}
