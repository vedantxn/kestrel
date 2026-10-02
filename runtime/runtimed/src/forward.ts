import { createServer, connect, type Server, type Socket } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { PROOF_HEADER } from "@kestrel/contracts";

const MAX_HEAD = 16 * 1024;
const HEAD_TIMEOUT_MS = 5_000;

const same = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );

/**
 * R7, C10. The CDP forward on port 9223. A connection is passed to Chrome's debugging port, byte
 * for byte and without parsing CDP, only if its first request carries this session's proof in
 * `x-kestrel-session-proof`. The proof is set by `configure`; until then every connection gets 503,
 * and a wrong proof gets 403. So a gateway holding a stale route to a reused address reaches nothing.
 *
 * The check is per connection: a connection that presented the proof is the gateway's, and carries
 * a whole CDP session or a keep-alive run of discovery requests.
 */
export class CdpForward {
  private proof: string | null = null;
  private server: Server | undefined;

  constructor(private readonly chromePort: number) {}

  /** Idempotent for the same proof; false if a different one was already set (a container serves one session). */
  setProof(proof: string): boolean {
    if (this.proof !== null) return same(this.proof, proof);
    this.proof = proof;
    return true;
  }

  get configured(): boolean {
    return this.proof !== null;
  }

  async listen(port: number, host = "0.0.0.0"): Promise<number> {
    this.server = createServer((client) => this.accept(client));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, resolve);
    });
    return (this.server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
  }

  private refuse(client: Socket, status: number, text: string): void {
    client.end(
      `HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
      () => client.destroy(),
    );
  }

  private accept(client: Socket): void {
    client.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => client.destroy(), HEAD_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_HEAD && buf.indexOf("\r\n\r\n") < 0) {
        clearTimeout(timer);
        client.off("data", onData);
        return this.refuse(client, 431, "Request Header Fields Too Large");
      }
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      this.decide(client, buf, buf.subarray(0, end).toString("latin1"));
    };
    client.on("data", onData);
    client.on("close", () => clearTimeout(timer));
  }

  private decide(client: Socket, all: Buffer, head: string): void {
    if (this.proof === null)
      return this.refuse(client, 503, "Service Unavailable");
    const m = new RegExp(`^${PROOF_HEADER}:[ \\t]*(.*?)[ \\t]*$`, "im").exec(
      head,
    );
    if (!m || !same(this.proof, m[1] ?? ""))
      return this.refuse(client, 403, "Forbidden");

    const chrome = connect({ host: "127.0.0.1", port: this.chromePort });
    chrome.on("error", () => client.destroy());
    chrome.once("connect", () => {
      chrome.write(all);
      client.pipe(chrome);
      chrome.pipe(client);
      client.resume();
    });
    client.on("close", () => chrome.destroy());
    chrome.on("close", () => client.destroy());
  }
}
