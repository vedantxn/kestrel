import { createServer, type AddressInfo } from "node:net";
import { connect } from "node:tls";
import { describe, expect, it } from "vitest";
import { parseClientHello } from "./hello.js";

/** The first bytes Node's own TLS client sends to `servername`. */
async function realHello(servername: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        try {
          if (parseClientHello(buf)) {
            sock.destroy();
            server.close();
            resolve(buf);
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      connect({ host: "127.0.0.1", port, servername }).on(
        "error",
        () => undefined,
      );
    });
  });
}

describe("parseClientHello", () => {
  it("reads the random, session id, server name and key shares of a real hello", async () => {
    const a = parseClientHello(await realHello("s1.example.com"))!;
    const b = parseClientHello(await realHello("s2.example.com"))!;
    expect(a.random).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sni).toBe("s1.example.com");
    expect(b.sni).toBe("s2.example.com");
    expect(a.keyShares.length).toBeGreaterThan(0);
    expect(a.random).not.toBe(b.random);
    expect(a.keyShares[0]).not.toBe(b.keyShares[0]);
  });

  it("waits for the whole message, a byte at a time", async () => {
    const full = await realHello("byte.example.com");
    for (let n = 0; n < full.length; n++)
      expect(parseClientHello(full.subarray(0, n))).toBeNull();
    expect(parseClientHello(full)?.sni).toBe("byte.example.com");
  });

  it("refuses what is not a TLS ClientHello", () => {
    expect(() =>
      parseClientHello(Buffer.from("GET / HTTP/1.1\r\n\r\n")),
    ).toThrow();
  });
});
