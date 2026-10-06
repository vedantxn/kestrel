import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  HARNESS_PATHS,
  ProbePolicyRequest,
  ProbeRequest,
  ProbeVmRequest,
} from "@kestrel/contracts";
import type { Logger } from "@kestrel/shared";
import { HarnessError, type NodeAgent } from "./agent.js";

const same = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );

/**
 * The agent's probe controls for the harness (G-23, docs/harness.md): only made when the agent
 * runs with KESTREL_HARNESS=on, and served only on a unix socket that root alone can open, with
 * the node secret as well. Nothing here is reachable from the agent's TCP listener, so the API
 * (which holds the node secret) cannot reach it, and in production it does not exist.
 */
export function createHarnessServer(
  agent: NodeAgent,
  secret: string,
  log: Logger,
): Server {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024) throw new HarnessError(400, "body too large");
      chunks.push(c as Buffer);
    }
    if (!chunks.length) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HarnessError(400, "invalid JSON");
    }
  };
  const parse = <T>(
    schema: {
      safeParse(
        v: unknown,
      ):
        | { success: true; data: T }
        | { success: false; error: { issues: { message: string }[] } };
    },
    v: unknown,
  ): T => {
    const r = schema.safeParse(v);
    if (!r.success)
      throw new HarnessError(400, r.error.issues[0]?.message ?? "invalid");
    return r.data;
  };

  return createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization;
      const presented =
        typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
          ? auth.slice(7).trim()
          : "";
      if (!presented || !same(presented, secret))
        return send(res, 401, { error: "unauthorized" });
      const path = new URL(req.url ?? "/", "http://harness").pathname;
      const under = (base: string) =>
        path.startsWith(`${base}/`)
          ? decodeURIComponent(path.slice(base.length + 1))
          : null;

      const ip = under(HARNESS_PATHS.probePolicy);
      if (ip !== null && req.method === "PUT") {
        const body = parse(ProbePolicyRequest, await readBody(req));
        return send(res, 200, await agent.leaseProbePolicy(ip, body.ttlMs));
      }
      if (ip !== null && req.method === "DELETE")
        return send(res, 200, { released: await agent.releaseProbePolicy(ip) });

      if (path === HARNESS_PATHS.probeVm && req.method === "POST") {
        const body = parse(ProbeVmRequest, await readBody(req));
        return send(res, 200, await agent.makeProbeVm(body.ttlMs));
      }
      const rest = under(HARNESS_PATHS.probeVm);
      if (rest !== null) {
        const [id, action] = rest.split("/");
        if (!id || !/^vm-[0-9a-f]{24}$/.test(id))
          return send(res, 400, { error: "invalid probe VM id" });
        if (action === "probe" && req.method === "POST") {
          const body = parse(ProbeRequest, await readBody(req));
          return send(res, 200, await agent.runProbe(id, body));
        }
        if (action === undefined && req.method === "DELETE")
          return send(res, 200, { removed: await agent.removeProbeVm(id) });
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof HarnessError)
        return send(res, e.status, { error: e.message });
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "harness request failed",
      );
      if (!res.headersSent)
        send(res, 500, {
          error: e instanceof Error ? e.message.slice(0, 200) : "internal",
        });
    }
  });
}

/** Listen on a unix socket only root can open (a stale one from a crash is replaced). */
export async function listenHarness(
  server: Server,
  socketPath: string,
): Promise<void> {
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
}
