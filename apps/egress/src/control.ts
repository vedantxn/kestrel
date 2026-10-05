import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { isIPv4 } from "node:net";
import {
  DenialsResponse,
  EGRESS_PATHS,
  EgressHealth,
  EgressPolicy,
  ListPoliciesResponse,
} from "@kestrel/contracts";
import type { Logger } from "@kestrel/shared";
import type { DenialLog } from "./denials.js";
import type { EgressMetrics } from "./metrics.js";
import type { PolicyStore } from "./policy.js";

/**
 * C7. The control API, on a Unix socket only the node agent can open (mode 0600; threat model
 * G-10). The socket's permissions are its authentication.
 */
export class ControlServer {
  private server: Server | undefined;

  constructor(
    private readonly policies: PolicyStore,
    private readonly denials: DenialLog,
    private readonly metrics: EgressMetrics,
    private readonly log: Logger,
  ) {}

  async listen(socketPath: string): Promise<void> {
    if (existsSync(socketPath)) unlinkSync(socketPath); // a stale socket from a crashed process
    this.server = createServer((req, res) => void this.handle(req, res));
    // Create the socket already private: with the default umask there is a moment before the chmod
    // when other users could open it.
    const previous = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(socketPath, resolve);
      });
    } finally {
      process.umask(previous);
    }
    chmodSync(socketPath, 0o600);
  }

  async close(): Promise<void> {
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 256 * 1024) throw new Error("body too large");
      chunks.push(c as Buffer);
    }
    return chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : undefined;
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://control");
      const path = url.pathname;

      if (req.method === "GET" && path === EGRESS_PATHS.health) {
        return this.send(
          res,
          200,
          EgressHealth.parse({
            status: "ok",
            policiesRestored: this.policies.restored,
            policyCount: this.policies.size,
          }),
        );
      }
      if (req.method === "POST" && path === EGRESS_PATHS.restored) {
        this.policies.restored = true;
        this.log.info(
          { policies: this.policies.size },
          "the node agent says all policies are restored",
        );
        return this.send(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === EGRESS_PATHS.policies) {
        const policies = this.policies.list().map(({ ip, entry }) => ({
          ip,
          sessionId: entry.sessionId,
          ...(entry.allow ? { allow: entry.allow } : {}),
          deny: entry.deny,
          connectionCap: entry.connectionCap,
          openConnections: entry.active,
        }));
        return this.send(res, 200, ListPoliciesResponse.parse({ policies }));
      }
      if (req.method === "GET" && path === EGRESS_PATHS.denials) {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isInteger(after) || after < 0)
          return this.send(res, 400, { error: "bad after" });
        const denials = this.denials.read(after).map((d) => ({
          seq: d.seq,
          sessionId: d.sessionId,
          host: d.host,
          port: d.port,
          reason: d.reason,
          count: d.count,
          at: new Date(d.at).toISOString(),
        }));
        return this.send(
          res,
          200,
          DenialsResponse.parse({ epoch: this.denials.epoch, denials }),
        );
      }
      const m = /^\/v1\/policies\/([0-9.]+)$/.exec(path);
      if (m && isIPv4(m[1] as string)) {
        const ip = m[1] as string;
        if (req.method === "PUT") {
          const parsed = EgressPolicy.safeParse(await this.body(req));
          if (!parsed.success)
            return this.send(res, 400, {
              error: parsed.error.issues[0]?.message ?? "invalid policy",
            });
          // Temporary until the proxy chains upstreams: refuse rather than exit directly.
          if (parsed.data.upstream)
            return this.send(res, 400, { error: "upstream not supported yet" });
          this.policies.set(ip, parsed.data);
          this.metrics.policies.set(this.policies.size);
          return this.send(res, 204);
        }
        if (req.method === "DELETE") {
          this.policies.delete(ip);
          this.metrics.policies.set(this.policies.size);
          return this.send(res, 204);
        }
      }
      this.send(res, 404, { error: "not found" });
    } catch (e) {
      this.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "control request failed",
      );
      this.send(res, 400, { error: "bad request" });
    }
  }
}
