import Docker from "dockerode";
import type { ProbeResult } from "@kestrel/contracts";
import { chromium, type BrowserContext } from "playwright-core";
import type { KestrelClient } from "./client.js";
import { agentState, type HostConfig } from "./collect.js";
import {
  leaseProbePolicy,
  makeProbeVm,
  probeFromVm,
  releaseProbePolicy,
  removeProbeVm,
  type HarnessNode,
} from "./harness-client.js";
import { nodeRuntimes, sessionsOn } from "./placement.js";

/**
 * H4, threat model G-04..G-06 and G-23. The isolation suite: everything a hostile page or a
 * compromised browser might try, from four places on every node, each expected to fail, plus a
 * positive control in each so a suite that cannot reach anything cannot pass.
 *
 *  1. from inside Chrome, through the proxy, the way a page does (in a container or a VM, as the
 *     node runs them);
 *  2. from a probe container on the node's bridge with no egress policy, with raw connections:
 *     proves the bridge's packet rules;
 *  2. on a microVM node, also from a probe VM: a clone of the template with no policy, in a
 *     namespace of its own exactly like a session's, making raw connections from inside the
 *     guest: proves the namespace's rules (G-23);
 *  3. from a probe container with a policy (a lease the agent keeps), sending hostile requests to
 *     the egress gateway: attacks its own parsing (spellings of internal addresses, names that
 *     resolve to them, odd ports).
 */
export interface IsolationNode extends HarnessNode {
  network: string;
  bridgeIp: string;
}

export interface IsolationConfig {
  nodes: IsolationNode[];
  host: HostConfig;
  publicIp: string;
  publicHostname: string;
  testPageUrl: string;
  probeImage: string;
}

export interface Finding {
  kind: 1 | 2 | 3;
  /** Where it was tried from: "node a, container", "node a, VM", ... */
  where?: string;
  name: string;
  pass: boolean;
  detail: string;
}

const docker = () => new Docker({ socketPath: "/var/run/docker.sock" });

/** The guest's side of every microVM clone (the snapshot holds it). */
const GUEST_GATEWAY = "172.16.0.1";

/** One raw attempt and what must come of it. */
export interface RawTarget {
  name: string;
  host: string;
  port: number;
  proto: "tcp" | "udp-dns";
  /** Bytes to send once connected; the answer's first line decides. */
  send?: string;
  /** refused: no connection and no DNS answer. connected: the positive control. denied: the egress gateway refused it. */
  expect: "refused" | "connected" | "denied";
}

const connect = (t: string) => `CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`;

/** G-06's raw targets, from a container or a probe VM on one node. */
export function rawTargets(o: {
  from: "container" | "vm";
  bridgeIp: string;
  publicIp: string;
  testHost: string;
  /** Other nodes' bridge addresses. */
  otherBridges: string[];
  /** Other sessions' addresses on this node. */
  neighbours: string[];
  /** A probe VM's own address on the bridge (its namespace's). */
  self?: string;
}): RawTarget[] {
  const t: RawTarget[] = [];
  const refuse = (host: string, port: number, what: string) =>
    t.push({
      name: `raw connection to ${host}:${port} (${what})`,
      host,
      port,
      proto: "tcp",
      expect: "refused",
    });
  const dns = (host: string, what: string) =>
    t.push({
      name: `DNS query to ${host}:53 (${what})`,
      host,
      port: 53,
      proto: "udp-dns",
      expect: "refused",
    });
  refuse("169.254.169.254", 80, "the cloud metadata service");
  refuse("169.254.169.254", 443, "the cloud metadata service (TLS)");
  refuse("169.254.170.2", 80, "the container credentials endpoint");
  refuse(o.bridgeIp, 22, "the host's SSH port");
  refuse(o.bridgeIp, 80, "the host's port 80 (Caddy)");
  refuse(o.bridgeIp, 443, "the host's port 443 (Caddy)");
  refuse(o.bridgeIp, 8443, "the gateway");
  refuse(o.bridgeIp, 8080, "the API");
  refuse(o.bridgeIp, 8081, "the API's internal listener");
  refuse(o.bridgeIp, 7001, "the node agent");
  refuse(o.bridgeIp, 5432, "Postgres");
  refuse(o.bridgeIp, 2375, "the Docker API");
  refuse(o.publicIp, 443, "the host's own public address");
  refuse(o.publicIp, 8443, "the gateway's public address");
  refuse("172.17.0.1", 80, "Docker's default bridge");
  refuse("10.20.1.1", 80, "the VPC router");
  refuse("1.1.1.1", 443, "the internet, directly");
  refuse("8.8.8.8", 53, "a public DNS server over TCP");
  dns("169.254.169.253", "the VPC's resolver at its link-local address");
  dns("10.20.0.2", "the VPC's resolver");
  dns("8.8.8.8", "a public resolver");
  dns(o.bridgeIp, "the host on the bridge");
  for (const b of o.otherBridges) {
    refuse(b, 3128, "another node's egress gateway");
    refuse(b, 7002, "another node's agent");
  }
  for (const n of o.neighbours) {
    refuse(n, 9223, "another session's CDP port");
    refuse(n, 9000, "another session's control port");
    refuse(n, 9222, "another session's Chrome");
  }
  const proxy = o.from === "vm" ? GUEST_GATEWAY : o.bridgeIp;
  if (o.from === "vm") {
    // The namespace itself, from the guest's side: only the proxy port is forwarded.
    for (const p of [22, 80, 3129, 7001, 9000])
      refuse(GUEST_GATEWAY, p, "the VM's namespace");
    dns(GUEST_GATEWAY, "the VM's namespace");
    if (o.self) {
      refuse(o.self, 9000, "its own control port, from inside (hairpin)");
      refuse(o.self, 9223, "its own CDP port, from inside (hairpin)");
    }
    refuse("10.200.255.1", 22, "the template build's link");
  }
  t.push({
    name: `a CONNECT to a public host with NO policy is refused (no_policy), via ${proxy}:3128`,
    host: proxy,
    port: 3128,
    proto: "tcp",
    send: connect(`${o.testHost}:443`),
    expect: "denied",
  });
  t.push({
    name: `positive control: raw connection to the egress port ${proxy}:3128`,
    host: proxy,
    port: 3128,
    proto: "tcp",
    expect: "connected",
  });
  return t;
}

/** Did the attempt come out as it must? */
export function judge(
  t: RawTarget,
  r: { result: string; head?: string; denied?: string | null } | undefined,
): { pass: boolean; detail: string } {
  if (!r) return { pass: false, detail: "no result" };
  const detail = `${r.result}${r.head ? ` ${r.head}` : ""}${r.denied ? ` [${r.denied}]` : ""}`;
  if (t.expect === "connected")
    return { pass: r.result === "connected", detail };
  if (t.expect === "denied") {
    const head = r.head ?? "";
    const refused =
      !/^HTTP\/1\.1 200/.test(head) &&
      (Boolean(r.denied) ||
        head === "" ||
        /^HTTP\/1\.1 (400|403|421|502|503)/.test(head));
    return { pass: refused, detail };
  }
  return {
    pass: r.result !== "connected" && r.result !== "answered",
    detail,
  };
}

// --- probe containers -----------------------------------------------------------------------------

/** Run a script in a running probe container, return stdout. */
async function exec(
  container: Docker.Container,
  script: string,
): Promise<string> {
  const e = await container.exec({
    Cmd: ["node", "-e", script],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await e.start({ hijack: true, stdin: false });
  return new Promise((resolve) => {
    let out = "";
    const demux = (
      docker() as unknown as {
        modem: { demuxStream(s: unknown, o: unknown, e: unknown): void };
      }
    ).modem;
    const sink = { write: (b: Buffer) => void (out += b.toString()) };
    demux.demuxStream(stream, sink, sink);
    stream.on("end", () => resolve(out));
    setTimeout(() => resolve(out), 120_000);
  });
}

async function withProbe<T>(
  cfg: IsolationConfig,
  n: IsolationNode,
  policy: boolean,
  fn: (c: Docker.Container, ip: string) => Promise<T>,
): Promise<T> {
  const d = docker();
  const name = `kestrel-probe-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const c = await d.createContainer({
    name,
    Image: cfg.probeImage,
    Cmd: ["node", "-e", "setTimeout(()=>{},3600e3)"],
    User: "65534:65534",
    Labels: { "kestrel.probe": "1" }, // not labelled with the node: the agent must not adopt or remove it
    HostConfig: {
      NetworkMode: n.network,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Dns: [],
    },
  });
  await c.start();
  const ip =
    (await c.inspect()).NetworkSettings.Networks[n.network]?.IPAddress ?? "";
  try {
    // A lease the agent keeps: reconciliation clears any policy no session or lease owns.
    if (policy) await leaseProbePolicy(n, ip);
    return await fn(c, ip);
  } finally {
    if (policy) await releaseProbePolicy(n, ip).catch(() => undefined);
    await c.remove({ force: true }).catch(() => undefined);
  }
}

/** The probe container's side of `rawTargets`: TCP (optionally sending) and DNS over UDP. */
const RAW_SCRIPT = (targets: RawTarget[]) => `
const net = require("net"), dgram = require("dgram"), crypto = require("crypto");
const targets = ${JSON.stringify(targets)};
const tcp = (t) => new Promise((resolve) => {
  const s = net.connect({ host: t.host, port: t.port }); let buf = ""; let connected = false; let done = false;
  const finish = (result) => { if (done) return; done = true; clearTimeout(tm); s.destroy();
    resolve({ name: t.name, result, head: t.send !== undefined && connected ? buf.split("\\r\\n")[0] : undefined,
      denied: (/x-kestrel-egress-denied:\\s*([a-z_]+)/i.exec(buf) || [])[1] || null }); };
  const tm = setTimeout(() => finish(connected ? "connected" : "timeout"), 3000);
  s.on("connect", () => { connected = true; if (t.send === undefined) return finish("connected"); s.write(Buffer.from(t.send, "latin1")); });
  s.on("data", (d) => { buf += d.toString("latin1"); if (buf.includes("\\r\\n\\r\\n")) finish("connected"); });
  s.on("close", () => finish(connected ? "connected" : "closed"));
  s.on("error", (e) => finish(connected ? "connected" : (e.code || "error")));
});
const dns = (t) => new Promise((resolve) => {
  const id = crypto.randomBytes(2); const s = dgram.createSocket("udp4"); let done = false;
  const finish = (result) => { if (done) return; done = true; clearTimeout(tm); s.close(); resolve({ name: t.name, result }); };
  const tm = setTimeout(() => finish("timeout"), 2000);
  s.on("message", (m) => { if (m.subarray(0, 2).equals(id)) finish("answered"); });
  s.on("error", (e) => finish(e.code || "error"));
  const q = Buffer.concat([id, Buffer.from([1,0,0,1,0,0,0,0,0,0,7]), Buffer.from("example"), Buffer.from([3]), Buffer.from("com"), Buffer.from([0,0,1,0,1])]);
  s.send(q, t.port, t.host, (e) => { if (e) finish(e.code || "error"); });
});
Promise.all(targets.map((t) => t.proto === "udp-dns" ? dns(t) : tcp(t))).then((r) => console.log(JSON.stringify(r)));
`;

function findings(
  kind: 2,
  where: string,
  targets: RawTarget[],
  results: {
    name: string;
    result: string;
    head?: string;
    denied?: string | null;
  }[],
): Finding[] {
  return targets.map((t) => ({
    kind,
    where,
    name: t.name,
    ...judge(
      t,
      results.find((r) => r.name === t.name),
    ),
  }));
}

/** Kind 2 from a probe container on the node's bridge, with no policy. */
export async function fromContainer(
  cfg: IsolationConfig,
  n: IsolationNode,
  neighbours: string[],
): Promise<Finding[]> {
  const where = `node ${n.node}, container`;
  const targets = rawTargets({
    from: "container",
    bridgeIp: n.bridgeIp,
    publicIp: cfg.publicIp,
    testHost: new URL(cfg.testPageUrl).hostname,
    otherBridges: cfg.nodes
      .filter((x) => x.node !== n.node)
      .map((x) => x.bridgeIp),
    neighbours,
  });
  const out = await withProbe(cfg, n, false, (c) =>
    exec(c, RAW_SCRIPT(targets)),
  );
  try {
    return findings(
      2,
      where,
      targets,
      JSON.parse(out.trim().split("\n").pop() ?? "[]"),
    );
  } catch {
    return [
      {
        kind: 2,
        where,
        name: "probe ran",
        pass: false,
        detail: `no result from the probe: ${out.slice(0, 200)}`,
      },
    ];
  }
}

/** Kind 2 from a probe VM (G-23): a clone of the template with no policy, in its own namespace. */
export async function fromVm(
  cfg: IsolationConfig,
  n: IsolationNode,
  neighbours: string[],
): Promise<Finding[]> {
  const where = `node ${n.node}, VM`;
  const vm = await makeProbeVm(n);
  try {
    const targets = rawTargets({
      from: "vm",
      bridgeIp: n.bridgeIp,
      publicIp: cfg.publicIp,
      testHost: new URL(cfg.testPageUrl).hostname,
      otherBridges: cfg.nodes
        .filter((x) => x.node !== n.node)
        .map((x) => x.bridgeIp),
      neighbours,
      self: vm.address,
    });
    const results: ProbeResult[] = [];
    for (let i = 0; i < targets.length; i += 64) {
      const chunk = targets.slice(i, i + 64);
      const r = await probeFromVm(n, vm.id, {
        targets: chunk.map((t) => ({
          name: t.name,
          host: t.host,
          port: t.port,
          proto: t.proto,
          ...(t.send !== undefined ? { send: t.send } : {}),
          timeoutMs: t.proto === "udp-dns" ? 2000 : 3000,
        })),
      });
      results.push(...r.results);
    }
    return findings(2, where, targets, results);
  } finally {
    await removeProbeVm(n, vm.id).catch(() => undefined);
  }
}

// --- kind 3: hostile requests to the egress gateway, from a probe with a policy -------------------

const PROXY_SCRIPT = (
  proxyHost: string,
  requests: { name: string; raw: string; expect: "deny" | "tunnel" }[],
) => `
const net = require("net"), tls = require("tls");
const reqs = ${JSON.stringify(requests)};
const run = (r) => new Promise((resolve) => {
  const s = net.connect({ host: ${JSON.stringify(proxyHost)}, port: 3128 });
  let buf = ""; let done = false;
  const finish = (extra) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve({ name: r.name, head: buf.split("\\r\\n")[0] || "", denied: /x-kestrel-egress-denied: (\\S+)/i.exec(buf)?.[1] || null, extra }); };
  const t = setTimeout(() => finish("timeout"), 8000);
  s.on("data", (d) => { buf += d.toString("latin1"); if (buf.includes("\\r\\n\\r\\n") && r.expect === "deny") finish(); if (r.expect === "tunnel" && /^HTTP\\/1.1 200/.test(buf)) {
      const host = r.tlsHost; const tl = tls.connect({ socket: s, servername: host });
      let page = ""; tl.on("data", (d) => { page += d.toString(); if (page.includes("</html>")) finish("title:" + (/<title>([^<]*)/.exec(page)||[])[1]); });
      tl.on("error", (e) => finish("tlserror:" + e.code)); tl.write("GET " + r.path + " HTTP/1.1\\r\\nHost: " + host + "\\r\\nConnection: close\\r\\n\\r\\n"); } });
  s.on("error", (e) => finish("error:" + e.code)); s.on("close", () => finish("closed"));
  s.write(r.raw);
});
(async () => { const out = []; for (const r of reqs) out.push(await run(r)); console.log(JSON.stringify(out)); })();
`;

export async function proxyAttacks(
  cfg: IsolationConfig,
  n: IsolationNode,
): Promise<Finding[]> {
  const where = `node ${n.node}, container with a policy`;
  const s3 = new URL(cfg.testPageUrl);
  const dash = (ip: string) => `${ip.replaceAll(".", "-")}.sslip.io`;
  const attacks: {
    name: string;
    raw: string;
    expect: "deny" | "tunnel";
    tlsHost?: string;
    path?: string;
  }[] = [];
  const add = (name: string, raw: string) =>
    attacks.push({ name, raw, expect: "deny" });

  for (const [t, why] of [
    ["169.254.169.254:80", "metadata"],
    ["169.254.170.2:80", "container credentials"],
    ["169.254.169.253:53", "the VPC's resolver"],
    ["127.0.0.1:80", "loopback"],
    ["10.20.1.1:80", "VPC address"],
    [`${n.bridgeIp}:80`, "the bridge's own address"],
    [`${n.bridgeIp}:8443`, "the gateway via the bridge"],
    ["100.100.100.200:80", "carrier-grade NAT metadata"],
    ["2852039166:80", "decimal metadata"],
    ["0xa9fea9fe:80", "hex metadata"],
    ["0251.0376.0251.0376:80", "octal metadata"],
    ["127.1:80", "short loopback"],
    ["[::1]:80", "IPv6 loopback"],
    ["[::ffff:169.254.169.254]:80", "IPv4-mapped metadata"],
    ["[::ffff:a9fe:a9fe]:80", "hex IPv4-mapped metadata"],
    ["[2606:4700::1111]:443", "a public IPv6 address"],
    [`${cfg.publicIp}:443`, "the host's own public address"],
    [`${cfg.publicIp}:8443`, "the gateway's public address"],
    [`${dash("169.254.169.254")}:80`, "a name that resolves to metadata"],
    [`${dash("127.0.0.1")}:80`, "a name that resolves to loopback"],
    [`${dash("10.0.0.5")}:443`, "a name that resolves to a private address"],
    [cfg.publicHostname + ":443", "the platform's own hostname"],
    [`${s3.hostname}:22`, "SSH on a public host"],
    [`${s3.hostname}:6379`, "Redis on a public host"],
    [`${s3.hostname}:8443`, "port 8443 on a public host"],
    [`${s3.hostname}:25`, "SMTP on a public host"],
    ...cfg.nodes
      .filter((x) => x.node !== n.node)
      .map((x) => [`${x.bridgeIp}:3128`, "another node's egress gateway"]),
  ] as const) {
    add(`CONNECT ${t} (${why})`, connect(t));
  }
  add(
    "GET http://169.254.169.254/ (metadata over plain HTTP)",
    "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n",
  );
  add(
    "a Host header that disagrees with the request line",
    `GET http://${s3.hostname}/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n`,
  );
  add(
    "credentials in the URL",
    `GET http://user:pw@${s3.hostname}/ HTTP/1.1\r\nHost: user:pw@${s3.hostname}\r\n\r\n`,
  );
  add(
    "a request body smuggled behind a GET",
    `GET http://${s3.hostname}/ HTTP/1.1\r\nHost: ${s3.hostname}\r\nTransfer-Encoding: chunked\r\n\r\n3a\r\nGET /x HTTP/1.1\r\nHost: evil\r\n\r\n\r\n0\r\n\r\n`,
  );
  add(
    "an origin-form request to the proxy itself",
    `GET /healthz HTTP/1.1\r\nHost: ${n.bridgeIp}:3128\r\n\r\n`,
  );
  add("a hostname with userinfo", connect(`user@${s3.hostname}:443`));
  add("a malformed CONNECT target", "CONNECT nonsense HTTP/1.1\r\n\r\n");
  attacks.push({
    name: "positive control: CONNECT to the test page's host loads it through the proxy",
    raw: connect(`${s3.hostname}:443`),
    expect: "tunnel",
    tlsHost: s3.hostname,
    path: s3.pathname,
  });

  const out = await withProbe(cfg, n, true, (c) =>
    exec(
      c,
      PROXY_SCRIPT(
        n.bridgeIp,
        attacks.map(({ name, raw, expect, tlsHost, path }) => ({
          name,
          raw,
          expect,
          ...(tlsHost ? { tlsHost, path } : {}),
        })),
      ),
    ),
  );
  let results: {
    name: string;
    head: string;
    denied: string | null;
    extra?: string;
  }[];
  try {
    results = JSON.parse(out.trim().split("\n").pop() ?? "[]");
  } catch {
    return [
      {
        kind: 3,
        where,
        name: "probe ran",
        pass: false,
        detail: `no result: ${out.slice(0, 200)}`,
      },
    ];
  }
  return attacks.map((a) => {
    const r = results.find((x) => x.name === a.name);
    if (!r)
      return { kind: 3, where, name: a.name, pass: false, detail: "no result" };
    if (a.expect === "tunnel")
      return {
        kind: 3,
        where,
        name: a.name,
        pass: r.extra === "title:Kestrel test page",
        detail: `${r.head} ${r.extra ?? ""}`,
      };
    const refused =
      !/^HTTP\/1\.1 200/.test(r.head) &&
      (r.denied !== null ||
        r.head === "" ||
        /^HTTP\/1\.1 (400|403|421|502|503)/.test(r.head));
    return {
      kind: 3,
      where,
      name: a.name,
      pass: refused,
      detail: `${r.head || r.extra || "closed"}${r.denied ? ` [${r.denied}]` : ""}`,
    };
  });
}

// --- kind 1: from inside Chrome ---------------------------------------------------------------------

export async function fromChrome(
  client: KestrelClient,
  cfg: IsolationConfig,
  n: IsolationNode,
  runtime: string,
  neighbours: string[],
): Promise<Finding[]> {
  const where = `node ${n.node}, Chrome in a ${runtime === "microvm" ? "VM" : "container"}`;
  const [session] = await sessionsOn(client, n.node, 1);
  const findings: Finding[] = [];
  try {
    const browser = await chromium.connectOverCDP(
      session!.connectUrl as string,
      { timeout: 30_000 },
    );
    const page =
      (browser.contexts()[0] ?? (await browser.newContext())).pages()[0] ??
      (await (browser.contexts()[0] as BrowserContext).newPage());
    const forbidden: [string, string][] = [
      ["http://169.254.169.254/latest/meta-data/", "the metadata service"],
      ["http://169.254.170.2/", "the container credentials endpoint"],
      ["http://localhost:9222/json/version", "Chrome's own debugging port"],
      [
        "http://127.0.0.1:9222/json/version",
        "Chrome's debugging port by address",
      ],
      ["http://127.0.0.1:9000/health", "runtimed's control port"],
      ["http://127.0.0.1:9223/json/version", "runtimed's CDP forward"],
      [
        `https://${cfg.publicHostname}/healthz`,
        "the platform's own public endpoint",
      ],
      [`http://${n.bridgeIp}:8081/healthz`, "the API's internal listener"],
      [`http://${n.bridgeIp}:7001/v1/describe`, "the node agent"],
      ["http://[::1]:9222/json/version", "IPv6 loopback"],
      ["http://2852039166/latest/meta-data/", "decimal-encoded metadata"],
    ];
    if (runtime === "microvm")
      forbidden.push([
        `http://${GUEST_GATEWAY}:3128/`,
        "the VM's namespace, as an origin",
      ]);
    for (const ip of neighbours)
      forbidden.push([`http://${ip}:9223/json/version`, "another session"]);
    for (const [url, what] of forbidden) {
      let detail: string;
      let pass: boolean;
      try {
        const r = await page.goto(url, { timeout: 15_000 });
        const denied = r?.headers()["x-kestrel-egress-denied"];
        pass = (r?.status() ?? 0) >= 400 || Boolean(denied);
        detail = `status ${r?.status()}${denied ? ` [${denied}]` : ""}`;
      } catch (e) {
        pass = true;
        detail = (e as Error).message.split("\n")[0]?.slice(0, 100) ?? "error";
      }
      findings.push({
        kind: 1,
        where,
        name: `Chrome loading ${url} (${what})`,
        pass,
        detail,
      });
    }
    try {
      // A new page: an earlier attack's navigation may still be unwinding on the old one.
      const ctx = browser.contexts()[0] as BrowserContext;
      const fresh = await ctx.newPage();
      await fresh.goto(cfg.testPageUrl, { timeout: 20_000 });
      const title = await fresh.title();
      findings.push({
        kind: 1,
        where,
        name: "positive control: Chrome loads the test page",
        pass: title === "Kestrel test page",
        detail: title,
      });
    } catch (e) {
      findings.push({
        kind: 1,
        where,
        name: "positive control: Chrome loads the test page",
        pass: false,
        detail: (e as Error).message.slice(0, 160),
      });
    }
    await browser.close().catch(() => undefined);
  } finally {
    await client.stop(session!.id).catch(() => undefined);
  }
  return findings;
}

/** Every kind, from every node, with a neighbouring session on that node to aim at. */
export async function runIsolationSuite(
  client: KestrelClient,
  cfg: IsolationConfig,
): Promise<Finding[]> {
  const runtimes = await nodeRuntimes(cfg.host);
  const out: Finding[] = [];
  for (const n of cfg.nodes) {
    const runtime = runtimes.get(n.node) ?? "docker";
    const step = async (what: string, fn: () => Promise<Finding[]>) => {
      try {
        out.push(...(await fn()));
      } catch (e) {
        out.push({
          kind: 2,
          where: `node ${n.node}`,
          name: `${what} ran`,
          pass: false,
          detail: (e as Error).message.slice(0, 300),
        });
      }
    };
    let held: Awaited<ReturnType<typeof sessionsOn>> = [];
    try {
      held = await sessionsOn(client, n.node, 1);
      const st = await agentState(cfg.host.nodes.find((x) => x.id === n.node)!);
      const neighbours = st.sessions
        .filter((b) => held.some((h) => h.id === b.sessionId) && b.address)
        .map((b) => b.address as string);
      await step("kind 1 (Chrome)", () =>
        fromChrome(client, cfg, n, runtime, neighbours),
      );
      await step("kind 2 (container)", () => fromContainer(cfg, n, neighbours));
      if (runtime === "microvm")
        await step("kind 2 (probe VM)", () => fromVm(cfg, n, neighbours));
      await step("kind 3 (egress parsing)", () => proxyAttacks(cfg, n));
    } catch (e) {
      out.push({
        kind: 1,
        where: `node ${n.node}`,
        name: "a neighbouring session on the node",
        pass: false,
        detail: (e as Error).message.slice(0, 300),
      });
    } finally {
      for (const h of held) await client.stop(h.id).catch(() => undefined);
    }
  }
  return out;
}
