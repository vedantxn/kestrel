#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { compare, type Report, type SessionObservation } from "./compare.js";
import { observe } from "./observe.js";
import { HelloRecorder } from "./recorder.js";

const USAGE = `snapshot-entropy-check: do these browsers share random state?

Reads Math.random, crypto.getRandomValues, crypto.randomUUID and a WebCrypto key from each
browser's first page and from a page it loads, and (with --tls-ip) records the TLS ClientHellos
each browser sends. Every value must be unique; anything two browsers share means their random
generators were in the same state, as in snapshot clones that were not reseeded.

Browsers (pick one):
  --cdp URL [--cdp URL ...]     CDP WebSocket URLs, one per browser (at least two)
  --cdp-cmd CMD --n N           run CMD N times; each prints a CDP URL (its last line)
  --kestrel URL --key KEY --n N create N Kestrel sessions (or KESTREL_URL, KESTREL_API_KEY)

Options:
  --page URL       a page each browser loads and is read again on (default https://example.com;
                   "none" to skip)
  --tls-ip IP      this machine's public IPv4: browsers connect to <name>.<ip>.sslip.io, where a
                   recorder on --tls-port reads their ClientHellos (needs root for port 443)
  --tls-domain D   instead of sslip.io: a domain whose every subdomain resolves to this machine
  --tls-port P     default 443 (Kestrel's egress allows only 80 and 443)
  --json FILE      write the observations and the report
  --timeout MS     per step (default 30000)

Exits 0 when nothing is shared, 1 when something is, 2 on a usage error.`;

const { values: a } = parseArgs({
  options: {
    cdp: { type: "string", multiple: true },
    "cdp-cmd": { type: "string" },
    kestrel: { type: "string" },
    key: { type: "string" },
    n: { type: "string" },
    page: { type: "string" },
    "tls-ip": { type: "string" },
    "tls-domain": { type: "string" },
    "tls-port": { type: "string" },
    json: { type: "string" },
    timeout: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (a.help) {
  console.log(USAGE);
  process.exit(0);
}
const usage = (msg: string): never => {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
};
const n = Number(a.n ?? 10);
const timeoutMs = Number(a.timeout ?? 30_000);
const pageUrl = a.page === "none" ? null : (a.page ?? "https://example.com");
const kestrelUrl = (a.kestrel ?? process.env.KESTREL_URL)?.replace(/\/+$/, "");
const kestrelKey = a.key ?? process.env.KESTREL_API_KEY;

/** A browser to observe, and how to let it go. */
interface Target {
  label: string;
  cdpUrl: string;
  release: () => Promise<void>;
}

async function kestrelSession(i: number): Promise<Target> {
  const headers = {
    authorization: `Bearer ${kestrelKey}`,
    "content-type": "application/json",
  };
  const res = await fetch(`${kestrelUrl}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ waitForCapacityMs: 60_000 }),
  });
  const s = (await res.json()) as {
    id?: string;
    connectUrl?: string;
    error?: { message?: string };
  };
  if (!res.ok || !s.id || !s.connectUrl)
    throw new Error(
      `create ${i}: ${res.status} ${s.error?.message ?? JSON.stringify(s)}`,
    );
  return {
    label: s.id,
    cdpUrl: s.connectUrl,
    release: async () => {
      await fetch(`${kestrelUrl}/v1/sessions/${s.id}/stop`, {
        method: "POST",
        headers,
      }).catch(() => undefined);
    },
  };
}

async function targets(): Promise<Target[]> {
  if (a.cdp?.length) {
    if (a.cdp.length < 2) usage("give at least two --cdp URLs");
    return a.cdp.map((u, i) => ({
      label: `cdp${i + 1}`,
      cdpUrl: u,
      release: async () => {},
    }));
  }
  if (a["cdp-cmd"]) {
    return Array.from({ length: n }, (_, i) => {
      const out = execSync(a["cdp-cmd"]!, { encoding: "utf8" })
        .trim()
        .split("\n");
      return {
        label: `cmd${i + 1}`,
        cdpUrl: out[out.length - 1]!,
        release: async () => {},
      };
    });
  }
  if (kestrelUrl && kestrelKey) {
    // One at a time, so each comes the way a customer's would: from the pool or a fresh restore.
    const list: Target[] = [];
    for (let i = 0; i < n; i++) list.push(await kestrelSession(i + 1));
    return list;
  }
  return usage("say which browsers: --cdp, --cdp-cmd, or --kestrel with --key");
}

function print(r: Report, obs: SessionObservation[]): void {
  for (const o of obs)
    if (o.error) console.log(`  ${o.label}: FAILED ${o.error}`);
  const w = Math.max(...r.items.map((i) => i.item.length));
  console.log(`\n${"item".padEnd(w)}  values  shared`);
  for (const i of r.items)
    console.log(
      `${i.item.padEnd(w)}  ${String(i.values).padStart(6)}  ${i.collisions.length ? `YES (${i.collisions.length})` : "no"}`,
    );
  for (const i of r.items)
    for (const c of i.collisions)
      console.log(
        `  shared ${i.item}: ${c.value.slice(0, 40)} in ${c.sessions.join(", ")}`,
      );
  if (r.maxAbsSkewMs !== null)
    console.log(
      `\nlargest clock difference from this machine: ${Math.round(r.maxAbsSkewMs)} ms`,
    );
  console.log(
    r.pass
      ? `\nPASS: ${r.sessions} browsers, nothing shared.`
      : `\nFAIL: ${r.sessions < 2 ? "fewer than two browsers observed" : "values shared between browsers (above)"}.`,
  );
}

const recorder = a["tls-ip"] || a["tls-domain"] ? new HelloRecorder() : null;
const tlsPort = Number(a["tls-port"] ?? 443);
if (recorder) await recorder.listen(tlsPort);
const domain =
  a["tls-domain"] ??
  (a["tls-ip"] ? `${a["tls-ip"].replace(/\./g, "-")}.sslip.io` : "");

const list = await targets();
const obs: SessionObservation[] = [];
try {
  for (const [i, t] of list.entries()) {
    process.stdout.write(`observing ${t.label} ... `);
    try {
      obs.push(
        await observe(t.label, t.cdpUrl, i + 1, {
          pageUrl,
          tls: recorder ? { recorder, domain, port: tlsPort } : null,
          timeoutMs,
        }),
      );
      console.log(
        `ok${recorder ? ` (${obs[obs.length - 1]!.hellos.length} hellos)` : ""}`,
      );
    } catch (e) {
      const error = (e as Error).message.split("\n")[0]!;
      obs.push({
        label: t.label,
        first: { math: [], grv: "", uuid: null, ecdh: null },
        page: null,
        skewMs: 0,
        hellos: [],
        error,
      });
      console.log(`failed: ${error}`);
    }
  }
} finally {
  await Promise.all(list.map((t) => t.release()));
  await recorder?.close();
}
const report = compare(obs);
print(report, obs);
if (a.json)
  await writeFile(
    a.json,
    JSON.stringify({ report, observations: obs }, null, 2),
  );
process.exit(report.pass ? 0 : 1);
