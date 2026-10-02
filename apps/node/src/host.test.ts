import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { encodeLine, newId } from "@kestrel/contracts";
import { createLogger } from "@kestrel/shared";
import * as selfsigned from "selfsigned";
import { describe, expect, it } from "vitest";
import { copyCertificate, findCaddyPair } from "./cert-copy.js";
import {
  Firewall,
  chainRestoreScript,
  expectedChainRules,
  type Exec,
  type FirewallConfig,
} from "./firewall.js";
import { GatewayHub } from "./gateway-hub.js";

const cfg: FirewallConfig = {
  nodeId: "a",
  iface: "ksl-a",
  bridgeIp: "172.30.1.1",
  egressPort: 3128,
};

/** A pretend iptables: remembers chains and rules, so ensure and verify can be checked against each other. */
function fakeIptables() {
  const chains = new Map<string, string[]>([
    ["INPUT", []],
    ["DOCKER-USER", ["-A DOCKER-USER -j RETURN"]],
  ]);
  const v6 = new Map<string, string[]>([["INPUT", []]]);
  const log: string[] = [];
  const history: string[][] = [];
  const exec: Exec = async (cmd, args, input) => {
    if (cmd === "iptables-restore") {
      // One transaction: the chain is replaced in a single step, so it is never observed empty.
      for (const line of (input ?? "").split("\n")) {
        if (line.startsWith(":")) {
          const c = line.slice(1).split(" ")[0] as string;
          if (!chains.has(c)) chains.set(c, []);
        } else if (line.startsWith("-F ")) {
          chains.set(line.slice(3), []);
        } else if (line.startsWith("-A ")) {
          const c = line.split(" ")[1] as string;
          chains.get(c)!.push(line);
        }
      }
      history.push([...(chains.get("KESTREL-IN-a") ?? [])]);
      return { code: 0, stdout: "", stderr: "" };
    }
    const table = cmd === "ip6tables" ? v6 : chains;
    const a = args.slice(2); // drop "-w 5"
    log.push(`${cmd} ${a.join(" ")}`);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const no = () => ({ code: 1, stdout: "", stderr: "no such chain or rule" });
    const [op, chain] = a as [string, string];
    if (op === "-N")
      return table.has(chain) ? no() : (table.set(chain, []), ok());
    if (op === "-F")
      return table.has(chain) ? (table.set(chain, []), ok()) : no();
    if (op === "-S") {
      if (!table.has(chain)) return no();
      const rules = table.get(chain)!;
      return ok(
        [
          chain === "INPUT" || chain === "DOCKER-USER"
            ? `-P ${chain} ACCEPT`
            : `-N ${chain}`,
          ...rules,
        ].join("\n"),
      );
    }
    const norm = (list: string[]) =>
      list
        .join(" ")
        .replace(
          "-m conntrack --ctstate RELATED,ESTABLISHED",
          "-m conntrack --ctstate RELATED,ESTABLISHED",
        );
    const render = (list: string[]) => {
      // iptables -S prints a destination as /32 and adds the implicit -m tcp for --dport
      const s = norm(list);
      return s.replace(
        /-d (\d+\.\d+\.\d+\.\d+)\/32 -p tcp -m tcp/,
        "-d $1/32 -p tcp -m tcp",
      );
    };
    if (op === "-A") {
      const rule = render(args.slice(4));
      if (!table.has(chain)) return no();
      table
        .get(chain)!
        .push(
          `-A ${chain} ${rule.replace(/^[A-Z-]+ /, "")}`.replace(
            `-A ${chain} ${chain} `,
            `-A ${chain} `,
          ),
        );
      return ok();
    }
    if (op === "-C")
      return table.get(chain)?.includes(`-A ${chain} ${render(args.slice(4))}`)
        ? ok()
        : no();
    if (op === "-I") {
      if (!table.has(chain)) return no();
      const pos = Number(args[4]);
      table
        .get(chain)!
        .splice(pos - 1, 0, `-A ${chain} ${render(args.slice(5))}`);
      return ok();
    }
    return no();
  };
  return { exec, chains, v6, log, history };
}

describe("firewall (N2-N4, G17)", () => {
  it("installs the chain, the entry in INPUT, the forwarding drops and the IPv6 drop", async () => {
    const f = fakeIptables();
    await new Firewall(cfg, f.exec).ensure();
    expect(f.chains.get("KESTREL-IN-a")).toEqual(
      expectedChainRules(cfg).slice(1),
    );
    expect(f.chains.get("INPUT")?.[0]).toBe(
      "-A INPUT -i ksl-a -j KESTREL-IN-a",
    );
    expect(f.chains.get("DOCKER-USER")).toEqual(
      expect.arrayContaining([
        "-A DOCKER-USER -i ksl-a -j DROP",
        "-A DOCKER-USER -o ksl-a -j DROP",
      ]),
    );
    expect(f.v6.get("INPUT")).toEqual(["-A INPUT -i ksl-a -j DROP"]);
  });

  it("uses the lock wait flag on every call, so two agents never collide", async () => {
    const f = fakeIptables();
    await new Firewall(cfg, f.exec).ensure();
    expect(f.log.length).toBeGreaterThan(5);
    const seen: string[] = [];
    const exec: Exec = async (cmd, args) => (
      seen.push(args.slice(0, 2).join(" ")),
      f.exec(cmd, args)
    );
    await new Firewall(cfg, exec).ensure();
    expect(new Set(seen)).toEqual(new Set(["-w 5"]));
  });

  it("is idempotent: running it again changes nothing", async () => {
    const f = fakeIptables();
    const fw = new Firewall(cfg, f.exec);
    await fw.ensure();
    const snapshot = JSON.stringify([...f.chains]);
    await fw.ensure();
    await fw.ensure();
    expect(JSON.stringify([...f.chains])).toBe(snapshot);
  });

  it("verifies a good setup, and names each way it can drift", async () => {
    const f = fakeIptables();
    const fw = new Firewall(cfg, f.exec);
    expect((await fw.verify()).ok).toBe(false); // nothing installed yet
    await fw.ensure();
    expect(await fw.verify()).toEqual({ ok: true, problems: [] });

    f.chains.get("KESTREL-IN-a")!.splice(1, 1); // someone deleted the egress accept
    expect((await fw.verify()).problems[0]).toMatch(
      /does not hold the expected rules/,
    );
    await fw.ensure();
    expect((await fw.verify()).ok).toBe(true);

    f.chains.get("INPUT")!.unshift("-A INPUT -j ACCEPT"); // something jumped the queue
    expect((await fw.verify()).problems.join()).toMatch(
      /does not enter KESTREL-IN-a first/,
    );
    await fw.ensure();
    f.chains.delete("KESTREL-IN-a"); // a flush
    expect((await fw.verify()).problems.join()).toMatch(
      /chain KESTREL-IN-a is missing/,
    );
    f.chains.set("DOCKER-USER", []);
    f.v6.set("INPUT", []);
    const problems = (await fw.verify()).problems.join("\n");
    expect(problems).toMatch(/DOCKER-USER does not drop forwarding from ksl-a/);
    expect(problems).toMatch(/ip6tables does not drop IPv6/);
  });

  it("owns a chain per node, so two nodes on one host do not touch each other's rules", async () => {
    const f = fakeIptables();
    await new Firewall(cfg, f.exec).ensure();
    await new Firewall(
      { ...cfg, nodeId: "b", iface: "ksl-b", bridgeIp: "172.30.2.1" },
      f.exec,
    ).ensure();
    expect(f.chains.has("KESTREL-IN-a") && f.chains.has("KESTREL-IN-b")).toBe(
      true,
    );
    expect((await new Firewall(cfg, f.exec).verify()).ok).toBe(true);
  });

  it("installs the chain in one transaction, never leaving it empty", async () => {
    const f = fakeIptables();
    const fw = new Firewall(cfg, f.exec);
    await fw.ensure();
    await fw.ensure();
    // every observed state of the chain is the complete rule set; none is a partial or empty one
    expect(f.history.every((h) => h.length === 3)).toBe(true);
    expect(f.log.some((l) => /^iptables -F /.test(l))).toBe(false);
    const script = chainRestoreScript(cfg);
    expect(
      script.startsWith("*filter\n:KESTREL-IN-a - [0:0]\n-F KESTREL-IN-a\n"),
    ).toBe(true);
    expect(script.trim().endsWith("COMMIT")).toBe(true);
  });

  it("checks order, not just presence: a preceding ACCEPT in DOCKER-USER or ip6tables is drift", async () => {
    const f = fakeIptables();
    const fw = new Firewall(cfg, f.exec);
    await fw.ensure();
    expect((await fw.verify()).ok).toBe(true);
    f.chains.get("DOCKER-USER")!.unshift("-A DOCKER-USER -j ACCEPT");
    expect((await fw.verify()).problems.join()).toMatch(
      /DOCKER-USER accepts or returns before dropping/,
    );
    f.chains.get("DOCKER-USER")!.shift();
    expect((await fw.verify()).ok).toBe(true);
    f.v6.get("INPUT")!.unshift("-A INPUT -j ACCEPT");
    expect((await fw.verify()).problems.join()).toMatch(
      /ip6tables accepts before dropping/,
    );
  });

  it("fails loudly if a command fails", async () => {
    const exec: Exec = async () => ({
      code: 4,
      stdout: "",
      stderr: "Resource temporarily unavailable",
    });
    await expect(new Firewall(cfg, exec).ensure()).rejects.toThrow(/failed/);
  });
});

describe("certificate copy (G16, threat model G-08)", () => {
  const make = async (cn: string) =>
    selfsigned.generate([{ name: "commonName", value: cn }], {
      keySize: 2048,
      algorithm: "sha256",
    });
  const HOST = "1-2-3-4.sslip.io";

  async function caddyTree(opts: { cert?: string; key?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), "caddy-"));
    const pair = await make(HOST);
    const dir = join(
      root,
      "caddy",
      "certificates",
      "acme-v02.api.letsencrypt.org-directory",
      HOST,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${HOST}.crt`), opts.cert ?? pair.cert);
    writeFileSync(join(dir, `${HOST}.key`), opts.key ?? pair.private, {
      mode: 0o600,
    });
    return { root, dir, pair };
  }
  const out = () => join(mkdtempSync(join(tmpdir(), "tls-")), "out");

  it("finds Caddy's pair wherever the issuer put it", async () => {
    const t = await caddyTree();
    expect(findCaddyPair(t.root, HOST)?.cert).toContain(HOST);
    expect(findCaddyPair(t.root, "other.example")).toBeNull();
    expect(findCaddyPair(join(t.root, "nowhere"), HOST)).toBeNull();
  });

  it("copies a valid pair, with the key private, and does nothing when it has not changed", async () => {
    const t = await caddyTree();
    const dest = out();
    expect(
      copyCertificate({ caddyData: t.root, hostname: HOST, outDir: dest }),
    ).toEqual({ copied: true });
    expect(readFileSync(join(dest, "cert.pem"), "utf8")).toBe(t.pair.cert);
    expect(readFileSync(join(dest, "key.pem"), "utf8")).toBe(t.pair.private);
    expect(statSync(join(dest, "key.pem")).mode & 0o777).toBe(0o600);
    expect(
      copyCertificate({ caddyData: t.root, hostname: HOST, outDir: dest }),
    ).toMatchObject({ copied: false, reason: "unchanged" });
  });

  it("picks up a renewal", async () => {
    const t = await caddyTree();
    const dest = out();
    copyCertificate({ caddyData: t.root, hostname: HOST, outDir: dest });
    const renewed = await make(HOST);
    writeFileSync(join(t.dir, `${HOST}.crt`), renewed.cert);
    writeFileSync(join(t.dir, `${HOST}.key`), renewed.private);
    expect(
      copyCertificate({ caddyData: t.root, hostname: HOST, outDir: dest })
        .copied,
    ).toBe(true);
    expect(readFileSync(join(dest, "cert.pem"), "utf8")).toBe(renewed.cert);
  });

  it("refuses a certificate and key that do not belong together", async () => {
    const other = await make("other");
    const t = await caddyTree({ key: other.private });
    const dest = out();
    expect(
      copyCertificate({ caddyData: t.root, hostname: HOST, outDir: dest }),
    ).toMatchObject({
      copied: false,
      reason: "certificate and key do not match",
    });
    expect(existsSync(join(dest, "key.pem"))).toBe(false);
  });

  it("does not follow a symlink planted where the key should be", async () => {
    const t = await caddyTree();
    const secret = join(mkdtempSync(join(tmpdir(), "secret-")), "shadow");
    writeFileSync(secret, "root:*:19000::::::\n");
    const keyPath = join(t.dir, `${HOST}.key`);
    writeFileSync(keyPath + ".real", "x");
    (await import("node:fs")).unlinkSync(keyPath);
    symlinkSync(secret, keyPath);
    const dest = out();
    const r = copyCertificate({
      caddyData: t.root,
      hostname: HOST,
      outDir: dest,
    });
    expect(r.copied).toBe(false);
    expect(existsSync(join(dest, "key.pem"))).toBe(false);
  });

  it("refuses an oversized file and reports an absent certificate without throwing", async () => {
    const t = await caddyTree({ cert: "x".repeat(200_000) });
    expect(
      copyCertificate({ caddyData: t.root, hostname: HOST, outDir: out() })
        .copied,
    ).toBe(false);
    expect(
      copyCertificate({
        caddyData: t.root,
        hostname: "absent.example",
        outDir: out(),
      }),
    ).toMatchObject({
      copied: false,
      reason: "no certificate for the hostname yet",
    });
  });

  it("never leaves a partial file where the gateway reads", async () => {
    const t = await caddyTree();
    const dest = out();
    copyCertificate({ caddyData: t.root, hostname: HOST, outDir: dest });
    const names = (await import("node:fs")).readdirSync(dest).sort();
    expect(names).toEqual(["cert.pem", "key.pem"]);
  });
});

describe("the gateway hub (G12)", () => {
  async function rig() {
    const dir = mkdtempSync(join(tmpdir(), "hub-"));
    const path = join(dir, "agent.sock");
    const attachments: [string, unknown][] = [];
    const gone: string[] = [];
    const ses = newId("ses");
    const route = {
      sessionId: ses as never,
      projectId: newId("prj") as never,
      address: "172.30.1.9",
      port: 9223,
      proof: "ab".repeat(32),
      notAfter: 4_000_000_000,
    };
    const hub = new GatewayHub({
      log: createLogger("t", "silent"),
      routes: () => [route],
      onAttachments: (g, a) => attachments.push([g, a]),
      onGone: (g) => gone.push(g),
    });
    await hub.listen(path);
    const client = () => {
      const s: Socket = connect(path);
      const lines: unknown[] = [];
      createInterface({ input: s }).on("line", (l) =>
        lines.push(JSON.parse(l)),
      );
      return { s, lines, send: (m: unknown) => s.write(encodeLine(m)) };
    };
    return { hub, path, attachments, gone, ses, route, client };
  }
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  it("is a socket only its owner can open", async () => {
    const { path, hub } = await rig();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await hub.close();
  });

  it("sends the route table when a gateway says hello, then every change, to every gateway", async () => {
    const r = await rig();
    const a = r.client();
    const b = r.client();
    a.send({
      type: "hello",
      protocolVersion: 1,
      gatewayId: "gA",
      attachments: [],
    });
    b.send({
      type: "hello",
      protocolVersion: 1,
      gatewayId: "gB",
      attachments: [{ sessionId: r.ses, connections: 1 }],
    });
    await wait();
    expect(a.lines[0]).toEqual({ type: "routes", routes: [r.route] });
    expect(r.attachments).toEqual([
      ["gA", []],
      ["gB", [{ sessionId: r.ses, connections: 1 }]],
    ]);
    const added = newId("ses");
    r.hub.putRoute({ ...r.route, sessionId: added as never });
    r.hub.removeRoute(r.ses);
    await wait();
    for (const c of [a, b]) {
      expect(c.lines[1]).toMatchObject({
        type: "route.put",
        route: { sessionId: added },
      });
      expect(c.lines[2]).toEqual({ type: "route.remove", sessionId: r.ses });
    }
    a.s.destroy();
    b.s.destroy();
    await r.hub.close();
  });

  it("takes attachment snapshots, and reports a gateway's departure", async () => {
    const r = await rig();
    const a = r.client();
    a.send({
      type: "hello",
      protocolVersion: 1,
      gatewayId: "gA",
      attachments: [],
    });
    a.send({
      type: "attachments",
      attachments: [{ sessionId: r.ses, connections: 3 }],
    });
    await wait();
    expect(r.attachments.at(-1)).toEqual([
      "gA",
      [{ sessionId: r.ses, connections: 3 }],
    ]);
    a.s.destroy();
    await wait();
    expect(r.gone).toEqual(["gA"]);
    await r.hub.close();
  });

  it("ignores garbage, and messages before hello", async () => {
    const r = await rig();
    const a = r.client();
    a.s.write("not json\n");
    a.send({
      type: "attachments",
      attachments: [{ sessionId: r.ses, connections: 1 }],
    }); // no hello yet
    await wait();
    expect(r.attachments).toEqual([]);
    a.send({
      type: "hello",
      protocolVersion: 1,
      gatewayId: "gA",
      attachments: [],
    });
    await wait();
    expect(r.attachments).toHaveLength(1);
    a.s.destroy();
    await r.hub.close();
  });

  it("replaces a stale socket file", async () => {
    const r = await rig();
    await r.hub.close();
    writeFileSync(r.path + ".x", "");
    chmodSync(r.path + ".x", 0o600);
    const again = new GatewayHub({
      log: createLogger("t", "silent"),
      routes: () => [],
      onAttachments: () => undefined,
      onGone: () => undefined,
    });
    await again.listen(r.path);
    await again.close();
  });
});
