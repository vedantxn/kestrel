import { createServer, type Server } from "node:net";
import { parseClientHello, type ClientHello } from "./hello.js";

/**
 * A TCP listener that reads each connection's TLS ClientHello and closes it: it never answers, so
 * the browser just sees a failed page load. Hellos are kept by server name, which tells sessions
 * apart (each navigates to its own name).
 */
export class HelloRecorder {
  readonly hellos: ClientHello[] = [];
  private server: Server | undefined;

  async listen(port: number, host = "0.0.0.0"): Promise<void> {
    this.server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.setTimeout(10_000, () => sock.destroy());
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        try {
          const h = parseClientHello(buf);
          if (!h) return;
          this.hellos.push(h);
        } catch {
          // Not TLS (a scanner, a plain HTTP probe): ignore it.
        }
        sock.destroy();
      });
      sock.on("error", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject).listen(port, host, () => resolve());
    });
  }

  /** The hellos whose server name starts with `prefix`. */
  for(prefix: string): ClientHello[] {
    return this.hellos.filter((h) => h.sni?.startsWith(prefix));
  }

  async close(): Promise<void> {
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
  }
}
