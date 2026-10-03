import { request } from "node:http";
import Docker from "dockerode";
import { newId } from "@kestrel/contracts";
import { chromium } from "playwright-core";
import type { KestrelClient } from "./client.js";

/**
 * H4, threat model G-04..G-06. The isolation suite: everything a hostile page or a compromised
 * container might try, from three places, each expected to fail, plus a positive control in each
 * so a suite that cannot reach anything cannot pass.
 *
 *  1. from inside Chrome, through the proxy, the way a page does;
 *  2. from a probe container with no egress policy, with raw connections: proves the packet rules;
 *  3. from a probe container with a policy, sending hostile requests to the egress gateway:
 *     attacks its own parsing (spellings of internal addresses, names that resolve to them, odd ports).
 */
export interface IsolationConfig {
  node: string;
  network: string;
  bridgeIp: string;
  egressSocket: string;
  publicIp: string;
  publicHostname: string;
  testPageUrl: string;
  probeImage: string;
}

export interface Finding {
  kind: 1 | 2 | 3;
  name: string;
  pass: boolean;
  detail: string;
}

const docker = () => new Docker({ socketPath: "/var/run/docker.sock" });

function egressPut(
  socketPath: string,
  ip: string,
  body: unknown | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        socketPath,
        method: body ? "PUT" : "DELETE",
        path: `/v1/policies/${ip}`,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode && res.statusCode < 300
            ? resolve()
            : reject(new Error(`egress ${res.statusCode}`)),
        );
      },
    );
    r.on("error", reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

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
      NetworkMode: cfg.network,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Dns: [],
    },
  });
  await c.start();
  const ip =
    (await c.inspect()).NetworkSettings.Networks[cfg.network]?.IPAddress ?? "";
  try {
    if (policy)
      await egressPut(cfg.egressSocket, ip, {
        sessionId: newId("ses"),
        connectionCap: 64,
      });
    return await fn(c, ip);
  } finally {
    if (policy)
      await egressPut(cfg.egressSocket, ip, null).catch(() => undefined);
    await c.remove({ force: true }).catch(() => undefined);
  }
}

// --- kind 2: raw connections from a container with no policy ------------------------------------

const RAW_SCRIPT = (targets: [string, number][]) => `
const net = require("net");
const targets = ${JSON.stringify(targets)};
Promise.all(targets.map(([host, port]) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); resolve({ host, port, result: "timeout" }); }, 3000);
  s.on("connect", () => { clearTimeout(t); s.destroy(); resolve({ host, port, result: "connected" }); });
  s.on("error", (e) => { clearTimeout(t); resolve({ host, port, result: e.code || "error" }); });
}))).then((r) => console.log(JSON.stringify(r)));
`;

export async function rawConnections(
  cfg: IsolationConfig,
  otherContainerIp: string | null,
): Promise<Finding[]> {
  const forbidden: [string, number, string][] = [
    ["169.254.169.254", 80, "the cloud metadata service"],
    ["169.254.169.254", 443, "the cloud metadata service (TLS)"],
    ["169.254.170.2", 80, "the container credentials endpoint"],
    [cfg.bridgeIp, 22, "the host's SSH port"],
    [cfg.bridgeIp, 80, "the host's port 80 (Caddy)"],
    [cfg.bridgeIp, 443, "the host's port 443 (Caddy)"],
    [cfg.bridgeIp, 8443, "the gateway"],
    [cfg.bridgeIp, 8080, "the API"],
    [cfg.bridgeIp, 8081, "the API's internal listener"],
    [cfg.bridgeIp, 7001, "the node agent"],
    [cfg.bridgeIp, 5432, "Postgres"],
    [cfg.bridgeIp, 2375, "the Docker API"],
    [cfg.publicIp, 443, "the host's own public address"],
    [cfg.publicIp, 8443, "the gateway's public address"],
    ["10.20.1.1", 80, "the VPC router"],
    ["1.1.1.1", 443, "the internet, directly"],
    ["8.8.8.8", 53, "a public DNS server"],
  ];
  if (otherContainerIp) {
    forbidden.push(
      [otherContainerIp, 9223, "another session's CDP port"],
      [otherContainerIp, 9000, "another session's control port"],
      [otherContainerIp, 9222, "another session's Chrome"],
    );
  }
  const targets: [string, number][] = [
    ...forbidden.map(([h, p]): [string, number] => [h, p]),
    [cfg.bridgeIp, 3128],
  ];
  const out = await withProbe(cfg, false, (c) => exec(c, RAW_SCRIPT(targets)));
  let results: { host: string; port: number; result: string }[];
  try {
    results = JSON.parse(out.trim().split("\n").pop() ?? "[]");
  } catch {
    return [
      {
        kind: 2,
        name: "probe ran",
        pass: false,
        detail: `no result from the probe: ${out.slice(0, 200)}`,
      },
    ];
  }
  const findings: Finding[] = [];
  for (const [h, p, what] of forbidden) {
    const r = results.find((x) => x.host === h && x.port === p);
    findings.push({
      kind: 2,
      name: `raw connection to ${h}:${p} (${what})`,
      pass: r !== undefined && r.result !== "connected",
      detail: r?.result ?? "no result",
    });
  }
  // Control: the one thing the packet rules allow is a new connection to the egress port.
  const ctl = results.find((x) => x.host === cfg.bridgeIp && x.port === 3128);
  findings.push({
    kind: 2,
    name: `positive control: raw connection to the egress port ${cfg.bridgeIp}:3128`,
    pass: ctl?.result === "connected",
    detail: ctl?.result ?? "no result",
  });
  return findings;
}

// --- kinds 2 and 3: requests to the egress gateway -----------------------------------------------

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
  kind: 2 | 3,
): Promise<Finding[]> {
  const s3 = new URL(cfg.testPageUrl);
  const connect = (t: string) => `CONNECT ${t} HTTP/1.1\r\nHost: ${t}\r\n\r\n`;
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

  if (kind === 2) {
    add(
      "a CONNECT to a public host with NO policy is refused (no_policy)",
      connect(`${s3.hostname}:443`),
    );
  } else {
    for (const [t, why] of [
      ["169.254.169.254:80", "metadata"],
      ["169.254.170.2:80", "container credentials"],
      ["127.0.0.1:80", "loopback"],
      ["10.20.1.1:80", "VPC address"],
      [`${cfg.bridgeIp}:80`, "the bridge's own address"],
      [`${cfg.bridgeIp}:8443`, "the gateway via the bridge"],
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
      `GET /healthz HTTP/1.1\r\nHost: ${cfg.bridgeIp}:3128\r\n\r\n`,
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
  }

  const run = async (c: Docker.Container): Promise<string> =>
    exec(
      c,
      PROXY_SCRIPT(
        cfg.bridgeIp,
        attacks.map(({ name, raw, expect, tlsHost, path }) => ({
          name,
          raw,
          expect,
          ...(tlsHost ? { tlsHost, path } : {}),
        })),
      ),
    );
  const out = await withProbe(cfg, kind === 3, (c) => run(c));
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
        kind,
        name: "probe ran",
        pass: false,
        detail: `no result: ${out.slice(0, 200)}`,
      },
    ];
  }
  return attacks.map((a) => {
    const r = results.find((x) => x.name === a.name);
    if (!r) return { kind, name: a.name, pass: false, detail: "no result" };
    if (a.expect === "tunnel")
      return {
        kind,
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
      kind,
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
  otherContainerIp: string | null,
): Promise<Finding[]> {
  const { session } = await client.create({});
  const findings: Finding[] = [];
  try {
    const browser = await chromium.connectOverCDP(
      session.connectUrl as string,
      { timeout: 30_000 },
    );
    const page =
      (browser.contexts()[0] ?? (await browser.newContext())).pages()[0] ??
      (await (
        browser.contexts()[0] as import("playwright-core").BrowserContext
      ).newPage());
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
      [`http://${cfg.bridgeIp}:8081/healthz`, "the API's internal listener"],
      [`http://${cfg.bridgeIp}:7001/v1/describe`, "the node agent"],
      ["http://[::1]:9222/json/version", "IPv6 loopback"],
      ["http://2852039166/latest/meta-data/", "decimal-encoded metadata"],
    ];
    if (otherContainerIp)
      forbidden.push([
        `http://${otherContainerIp}:9223/json/version`,
        "another session",
      ]);
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
        name: `Chrome loading ${url} (${what})`,
        pass,
        detail,
      });
    }
    try {
      // A new page: an earlier attack's navigation may still be unwinding on the old one.
      const ctx =
        browser.contexts()[0] as import("playwright-core").BrowserContext;
      const fresh = await ctx.newPage();
      await fresh.goto(cfg.testPageUrl, { timeout: 20_000 });
      const title = await fresh.title();
      findings.push({
        kind: 1,
        name: "positive control: Chrome loads the test page",
        pass: title === "Kestrel test page",
        detail: title,
      });
    } catch (e) {
      findings.push({
        kind: 1,
        name: "positive control: Chrome loads the test page",
        pass: false,
        detail: (e as Error).message.slice(0, 160),
      });
    }
    await browser.close().catch(() => undefined);
  } finally {
    await client.stop(session.id).catch(() => undefined);
  }
  return findings;
}

export async function runIsolationSuite(
  client: KestrelClient,
  cfg: IsolationConfig,
): Promise<Finding[]> {
  // Another session's address, for the attacks that name it.
  const hold = await client.create({});
  const info = await docker().listContainers({
    filters: { label: ["kestrel.role=session"] },
  });
  const mine = info.find((c) => c.Labels["kestrel.role"] === "session");
  const other = mine
    ? (Object.values(mine.NetworkSettings.Networks)[0]?.IPAddress ?? null)
    : null;
  try {
    return [
      ...(await fromChrome(client, cfg, other)),
      ...(await rawConnections(cfg, other)),
      ...(await proxyAttacks(cfg, 2)),
      ...(await proxyAttacks(cfg, 3)),
    ];
  } finally {
    await client.stop(hold.session.id).catch(() => undefined);
  }
}
