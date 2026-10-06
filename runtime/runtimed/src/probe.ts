import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { createConnection } from "node:net";
import type {
  ProbeRequest,
  ProbeResponse,
  ProbeResult,
} from "@kestrel/contracts";
import type { z } from "zod";

type Target = z.output<typeof ProbeRequest>["targets"][number];

/**
 * Threat model G-23. The harness's probe VM: a clone of the template that is never a session.
 * From inside the guest, with no proxy, it tries what a compromised browser would: raw TCP
 * connections and DNS queries to the metadata service, the host, the neighbours and the internet.
 * The guest's network namespace must refuse each, exactly as the bridge refuses a container.
 */
export async function runProbe(
  req: z.output<typeof ProbeRequest>,
): Promise<ProbeResponse> {
  return {
    results: await Promise.all(
      req.targets.map((t) => (t.proto === "udp-dns" ? dns(t) : tcp(t))),
    ),
  };
}

/** Printable ASCII only, bounded: the line goes back to the agent and into a report. */
const clean = (s: string, max: number): string =>
  s.replace(/[^\x20-\x7e]/g, "?").slice(0, max);

function tcp(t: Target): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let buf = "";
    let connected = false;
    let done = false;
    const s = createConnection({ host: t.host, port: t.port });
    const finish = (result: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      if (t.send === undefined || !connected)
        return resolve({ name: t.name, result });
      const denied = /x-kestrel-egress-denied:\s*([a-z_]+)/i.exec(buf)?.[1];
      resolve({
        name: t.name,
        result,
        head: clean(buf.split("\r\n")[0] ?? "", 512),
        denied: denied ? clean(denied, 64) : null,
      });
    };
    const timer = setTimeout(
      () => finish(connected ? "connected" : "timeout"),
      t.timeoutMs,
    );
    s.on("connect", () => {
      connected = true;
      if (t.send === undefined) return finish("connected");
      s.write(Buffer.from(t.send, "latin1"));
    });
    s.on("data", (d: Buffer) => {
      if (buf.length < 4096) buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n") || buf.length >= 4096) finish("connected");
    });
    s.on("close", () => finish(connected ? "connected" : "closed"));
    s.on("error", (e: NodeJS.ErrnoException) =>
      finish(connected ? "connected" : clean(e.code ?? "error", 64)),
    );
  });
}

/** A query for `example.com`, type A: any answer at all means the resolver was reachable. */
export function dnsQuery(id: Buffer): Buffer {
  const name = Buffer.concat([
    Buffer.from([7]),
    Buffer.from("example", "ascii"),
    Buffer.from([3]),
    Buffer.from("com", "ascii"),
    Buffer.from([0]),
  ]);
  return Buffer.concat([
    id,
    Buffer.from([0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
    name,
    Buffer.from([0, 1, 0, 1]),
  ]);
}

function dns(t: Target): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const id = randomBytes(2);
    const sock = createSocket(t.host.includes(":") ? "udp6" : "udp4");
    let done = false;
    const finish = (result: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      resolve({ name: t.name, result });
    };
    const timer = setTimeout(() => finish("timeout"), t.timeoutMs);
    sock.on("message", (m: Buffer) => {
      if (m.length >= 2 && m.subarray(0, 2).equals(id)) finish("answered");
    });
    sock.on("error", (e: NodeJS.ErrnoException) =>
      finish(clean(e.code ?? "error", 64)),
    );
    sock.send(dnsQuery(id), t.port, t.host, (e) => {
      if (e) finish(clean((e as NodeJS.ErrnoException).code ?? "error", 64));
    });
  });
}
