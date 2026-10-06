import { createSocket } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import { ProbeRequest, ProbeResponse } from "@kestrel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { dnsQuery, runProbe } from "./probe.js";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

async function listen(onConn: (s: Socket) => void) {
  const srv: Server = createServer(onConn);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closers.push(() => srv.close());
  return (srv.address() as { port: number }).port;
}

describe("the probe (G-23)", () => {
  it("reports a connection, a refusal, and an answer with its denial reason", async () => {
    const open = await listen((s) => s.end());
    const proxy = await listen((s) =>
      s.on("data", () =>
        s.end(
          "HTTP/1.1 403 Forbidden\r\nx-kestrel-egress-denied: no_policy\r\n\r\n",
        ),
      ),
    );
    const closed = await listen(() => undefined);
    // A port that was listening and is not any more: the connection is refused.
    const refused = closed;
    closers.pop()!();
    const out = await runProbe(
      ProbeRequest.parse({
        targets: [
          { name: "open", host: "127.0.0.1", port: open },
          { name: "refused", host: "127.0.0.1", port: refused },
          {
            name: "proxy",
            host: "127.0.0.1",
            port: proxy,
            send: "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
          },
        ],
      }),
    );
    expect(ProbeResponse.parse(out).results).toEqual([
      { name: "open", result: "connected" },
      { name: "refused", result: "ECONNREFUSED" },
      {
        name: "proxy",
        result: "connected",
        head: "HTTP/1.1 403 Forbidden",
        denied: "no_policy",
      },
    ]);
  });

  it("times out where nothing answers", async () => {
    // TEST-NET-1 is never routed: the SYN goes nowhere.
    const out = await runProbe(
      ProbeRequest.parse({
        targets: [
          { name: "x", host: "192.0.2.1", port: 80, timeoutMs: 200 },
          {
            name: "dns",
            host: "127.0.0.1",
            port: 9,
            proto: "udp-dns",
            timeoutMs: 200,
          },
        ],
      }),
    );
    expect(out.results[0]!.result).not.toBe("connected");
    expect(out.results[1]!.result).not.toBe("answered");
  });

  it("knows a resolver answered", async () => {
    const udp = createSocket("udp4");
    udp.on("message", (m, r) =>
      udp.send(
        Buffer.concat([m.subarray(0, 2), Buffer.alloc(10)]),
        r.port,
        r.address,
      ),
    );
    await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
    closers.push(() => udp.close());
    const out = await runProbe(
      ProbeRequest.parse({
        targets: [
          {
            name: "dns",
            host: "127.0.0.1",
            port: udp.address().port,
            proto: "udp-dns",
          },
        ],
      }),
    );
    expect(out.results).toEqual([{ name: "dns", result: "answered" }]);
  });

  it("builds a well-formed DNS query", () => {
    const q = dnsQuery(Buffer.from([0xab, 0xcd]));
    expect(q.subarray(0, 2)).toEqual(Buffer.from([0xab, 0xcd]));
    expect(q.toString("latin1")).toContain("\x07example\x03com\x00");
    expect(q.readUInt16BE(4)).toBe(1); // one question
  });
});
