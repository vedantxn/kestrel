import { execFile } from "node:child_process";

/**
 * N2-N4, G17. The packet rules that make the egress gateway a session container's only way out.
 * Each node owns one chain in the host's input path (`KESTREL-IN-<node>`), entered only for
 * traffic arriving from its bridge:
 *
 *   accept replies to connections the host opened (so the gateway and agent can talk to containers)
 *   accept new TCP connections to the egress port on the bridge's own address
 *   drop everything else
 *
 * Forwarding to or from the bridge is dropped, and IPv6 from the bridge is dropped. Rules use
 * `-w` (wait for the xtables lock) so two agents on one host never collide.
 *
 * The chain's contents are installed with one `iptables-restore` transaction. Flushing the chain
 * and adding rules one by one would leave it empty for a few process launches, and an empty chain
 * lets traffic fall through to the host's other rules, whose first rule accepts established
 * connections: a connection opened in that window would persist.
 */
export interface FirewallConfig {
  nodeId: string;
  /** The bridge's interface name, set explicitly when the network is created (N1). */
  iface: string;
  bridgeIp: string;
  egressPort: number;
}

export type Exec = (
  cmd: string,
  args: string[],
  input?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realExec: Exec = (cmd, args, input) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err
          ? (err as NodeJS.ErrnoException & { code?: number | string }).code ===
            "ENOENT"
            ? 127
            : Number((err as { code?: number }).code ?? 1)
          : 0;
        resolve({
          code: Number.isFinite(code) ? code : 1,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
  });

const chainName = (nodeId: string): string => `KESTREL-IN-${nodeId}`;

/** The rules the chain must contain, in order, as `iptables -S` prints them. */
export function expectedChainRules(c: FirewallConfig): string[] {
  const chain = chainName(c.nodeId);
  return [
    `-N ${chain}`,
    `-A ${chain} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`,
    `-A ${chain} -d ${c.bridgeIp}/32 -p tcp -m tcp --dport ${c.egressPort} -m conntrack --ctstate NEW -j ACCEPT`,
    `-A ${chain} -j DROP`,
  ];
}

/** The same chain as an `iptables-restore` transaction: created if absent, flushed and refilled atomically. */
export function chainRestoreScript(c: FirewallConfig): string {
  const chain = chainName(c.nodeId);
  const rules = expectedChainRules(c).slice(1);
  return [
    "*filter",
    `:${chain} - [0:0]`,
    `-F ${chain}`,
    ...rules,
    "COMMIT",
    "",
  ].join("\n");
}

export interface FirewallStatus {
  ok: boolean;
  problems: string[];
}

export class Firewall {
  constructor(
    private readonly c: FirewallConfig,
    private readonly exec: Exec = realExec,
  ) {}

  private async ipt(
    args: string[],
    bin = "iptables",
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.exec(bin, ["-w", "5", ...args]);
  }

  private async must(args: string[], bin = "iptables"): Promise<void> {
    const r = await this.ipt(args, bin);
    if (r.code !== 0)
      throw new Error(
        `${bin} ${args.join(" ")} failed: ${r.stderr.trim() || r.code}`,
      );
  }

  /** Install everything, replacing whatever the chain held. Safe to run repeatedly. */
  async ensure(): Promise<void> {
    const chain = chainName(this.c.nodeId);
    const restored = await this.exec(
      "iptables-restore",
      ["-w", "5", "--noflush"],
      chainRestoreScript(this.c),
    );
    if (restored.code !== 0)
      throw new Error(
        `iptables-restore failed: ${restored.stderr.trim() || restored.code}`,
      );

    // Enter the chain first in INPUT, only for traffic from this bridge.
    if (
      (await this.ipt(["-C", "INPUT", "-i", this.c.iface, "-j", chain]))
        .code !== 0
    ) {
      await this.must(["-I", "INPUT", "1", "-i", this.c.iface, "-j", chain]);
    }
    // Forwarding to or from the bridge is dropped. DOCKER-USER runs before Docker's own forwarding rules.
    for (const dir of ["-i", "-o"]) {
      if (
        (await this.ipt(["-C", "DOCKER-USER", dir, this.c.iface, "-j", "DROP"]))
          .code !== 0
      ) {
        await this.must([
          "-I",
          "DOCKER-USER",
          "1",
          dir,
          this.c.iface,
          "-j",
          "DROP",
        ]);
      }
    }
    // IPv6 from the bridge is dropped (the network has none, N1; this is belt and braces).
    if (
      (
        await this.ipt(
          ["-C", "INPUT", "-i", this.c.iface, "-j", "DROP"],
          "ip6tables",
        )
      ).code !== 0
    ) {
      await this.must(
        ["-I", "INPUT", "1", "-i", this.c.iface, "-j", "DROP"],
        "ip6tables",
      );
    }
  }

  /** Compare what is installed with what must be. Used before the first container is made and every 30 s (G17). */
  async verify(): Promise<FirewallStatus> {
    const problems: string[] = [];
    const chain = chainName(this.c.nodeId);
    const rulesOf = (out: string, table: string): string[] =>
      out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith(`-A ${table} `));

    const listed = await this.ipt(["-S", chain]);
    if (listed.code !== 0) {
      problems.push(`chain ${chain} is missing`);
    } else {
      const have = listed.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const want = expectedChainRules(this.c);
      if (have.length !== want.length || want.some((w, i) => have[i] !== w)) {
        problems.push(
          `chain ${chain} does not hold the expected rules:\nwant ${JSON.stringify(want)}\nhave ${JSON.stringify(have)}`,
        );
      }
    }

    // Our entry must come before anything that could accept the traffic. Another node's entry on a
    // different interface may precede it (two nodes share one host), nothing else may.
    const inputRules = rulesOf(
      (await this.ipt(["-S", "INPUT"])).stdout,
      "INPUT",
    );
    const own = `-A INPUT -i ${this.c.iface} -j ${chain}`;
    const at = inputRules.indexOf(own);
    const siblings = /^-A INPUT -i \S+ -j KESTREL-IN-\S+$/;
    if (at < 0 || inputRules.slice(0, at).some((r) => !siblings.test(r)))
      problems.push(`INPUT does not enter ${chain} first for ${this.c.iface}`);

    // Forwarding drops must precede anything that accepts or returns (Docker's own rule is a RETURN at the end).
    const userRules = rulesOf(
      (await this.ipt(["-S", "DOCKER-USER"])).stdout,
      "DOCKER-USER",
    );
    for (const dir of ["-i", "-o"]) {
      const mine = `-A DOCKER-USER ${dir} ${this.c.iface} -j DROP`;
      const idx = userRules.indexOf(mine);
      const firstOther = userRules.findIndex((r) =>
        /-j (ACCEPT|RETURN)\b/.test(r),
      );
      if (idx < 0)
        problems.push(
          `DOCKER-USER does not drop forwarding ${dir === "-i" ? "from" : "to"} ${this.c.iface}`,
        );
      else if (firstOther >= 0 && firstOther < idx)
        problems.push(
          `DOCKER-USER accepts or returns before dropping ${dir === "-i" ? "from" : "to"} ${this.c.iface}`,
        );
    }

    const v6Rules = rulesOf(
      (await this.ipt(["-S", "INPUT"], "ip6tables")).stdout,
      "INPUT",
    );
    const v6 = `-A INPUT -i ${this.c.iface} -j DROP`;
    const v6At = v6Rules.indexOf(v6);
    const v6Accept = v6Rules.findIndex((r) => /-j ACCEPT\b/.test(r));
    if (v6At < 0)
      problems.push(`ip6tables does not drop IPv6 from ${this.c.iface}`);
    else if (v6Accept >= 0 && v6Accept < v6At)
      problems.push(
        `ip6tables accepts before dropping IPv6 from ${this.c.iface}`,
      );
    return { ok: problems.length === 0, problems };
  }
}
