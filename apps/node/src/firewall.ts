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
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(
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
    const exists = (await this.ipt(["-S", chain])).code === 0;
    if (!exists) await this.must(["-N", chain]);
    await this.must(["-F", chain]);
    await this.must([
      "-A",
      chain,
      "-m",
      "conntrack",
      "--ctstate",
      "RELATED,ESTABLISHED",
      "-j",
      "ACCEPT",
    ]);
    await this.must([
      "-A",
      chain,
      "-d",
      `${this.c.bridgeIp}/32`,
      "-p",
      "tcp",
      "-m",
      "tcp",
      "--dport",
      String(this.c.egressPort),
      "-m",
      "conntrack",
      "--ctstate",
      "NEW",
      "-j",
      "ACCEPT",
    ]);
    await this.must(["-A", chain, "-j", "DROP"]);

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
    const input = await this.ipt(["-S", "INPUT"]);
    const inputRules = input.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-A INPUT"));
    // Our entry must come before anything that could accept the traffic. Another node's entry on a
    // different interface may precede it (two nodes share one host), nothing else may.
    const own = `-A INPUT -i ${this.c.iface} -j ${chain}`;
    const at = inputRules.indexOf(own);
    const siblings = /^-A INPUT -i \S+ -j KESTREL-IN-\S+$/;
    if (at < 0 || inputRules.slice(0, at).some((r) => !siblings.test(r)))
      problems.push(`INPUT does not enter ${chain} first for ${this.c.iface}`);
    const user = (await this.ipt(["-S", "DOCKER-USER"])).stdout;
    for (const dir of ["-i", "-o"]) {
      if (!user.includes(`-A DOCKER-USER ${dir} ${this.c.iface} -j DROP`))
        problems.push(
          `DOCKER-USER does not drop forwarding ${dir === "-i" ? "from" : "to"} ${this.c.iface}`,
        );
    }
    const v6 = (await this.ipt(["-S", "INPUT"], "ip6tables")).stdout;
    if (!v6.includes(`-A INPUT -i ${this.c.iface} -j DROP`))
      problems.push(`ip6tables does not drop IPv6 from ${this.c.iface}`);
    return { ok: problems.length === 0, problems };
  }
}
