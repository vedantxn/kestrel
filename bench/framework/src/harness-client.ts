import { readFileSync } from "node:fs";
import { request } from "node:http";
import {
  HARNESS_PATHS,
  ProbeLease,
  ProbeResponse,
  ProbeVm,
  type ProbeRequest,
} from "@kestrel/contracts";

/**
 * The node agent's probe controls (docs/harness.md): a unix socket only root can open, there only
 * while the agent runs with KESTREL_HARNESS=on (`infra/host/bench.sh` turns it on for m1 and m2).
 */
export interface HarnessNode {
  node: string;
  harnessSocket: string;
  secretFile: string;
}

export class HarnessUnavailable extends Error {}

function call(
  n: HarnessNode,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<unknown> {
  const secret = readFileSync(n.secretFile, "utf8").trim();
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = request(
      {
        socketPath: n.harnessSocket,
        method,
        path,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }
            : {}),
        },
      },
      (res) => {
        let t = "";
        res.on("data", (c: Buffer) => {
          if (t.length < 256 * 1024) t += c.toString();
        });
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(t);
          } catch {
            json = { error: t.slice(0, 200) };
          }
          if ((res.statusCode ?? 500) < 300) resolve(json);
          else
            reject(
              new Error(
                `harness ${method} ${path}: ${res.statusCode} ${(json as { error?: string }).error ?? ""}`,
              ),
            );
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error(`harness ${path}: timed out`)));
    r.on("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? new HarnessUnavailable(
              `node ${n.node}'s harness surface is off (no ${n.harnessSocket}): run the harness through infra/host/bench.sh, which deploys the agents with KESTREL_HARNESS=on`,
            )
          : e,
      ),
    );
    r.end(data);
  });
}

export async function leaseProbePolicy(
  n: HarnessNode,
  ip: string,
  ttlMs = 5 * 60_000,
): Promise<ProbeLease> {
  return ProbeLease.parse(
    await call(
      n,
      "PUT",
      `${HARNESS_PATHS.probePolicy}/${encodeURIComponent(ip)}`,
      { ttlMs },
    ),
  );
}

export async function releaseProbePolicy(
  n: HarnessNode,
  ip: string,
): Promise<void> {
  await call(
    n,
    "DELETE",
    `${HARNESS_PATHS.probePolicy}/${encodeURIComponent(ip)}`,
  );
}

export async function makeProbeVm(
  n: HarnessNode,
  ttlMs = 5 * 60_000,
): Promise<ProbeVm> {
  return ProbeVm.parse(await call(n, "POST", HARNESS_PATHS.probeVm, { ttlMs }));
}

/** Raw attempts from inside the probe VM; the guest's answer is checked against its contract. */
export async function probeFromVm(
  n: HarnessNode,
  id: string,
  req: ProbeRequest,
): Promise<ProbeResponse> {
  return ProbeResponse.parse(
    await call(n, "POST", `${HARNESS_PATHS.probeVm}/${id}/probe`, req),
  );
}

export async function removeProbeVm(n: HarnessNode, id: string): Promise<void> {
  await call(n, "DELETE", `${HARNESS_PATHS.probeVm}/${id}`);
}
