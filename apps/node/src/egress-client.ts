import { request } from "node:http";
import {
  DenialsResponse,
  EGRESS_PATHS,
  EgressHealth,
  ListPoliciesResponse,
  type EgressPolicy,
} from "@kestrel/contracts";

/** The agent's side of the egress gateway's control API (C7): a Unix socket only this process can open. */
export interface EgressClient {
  setPolicy(ip: string, policy: EgressPolicy): Promise<void>;
  clearPolicy(ip: string): Promise<void>;
  list(): Promise<ListPoliciesResponse>;
  restored(): Promise<void>;
  health(): Promise<EgressHealth>;
  denials(after: number): Promise<DenialsResponse>;
}

export class UnixEgressClient implements EgressClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 3000,
  ) {}

  private call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const r = request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: { "content-type": "application/json" },
          timeout: this.timeoutMs,
        },
        (res) => {
          let text = "";
          res.on("data", (d: Buffer) => {
            text += d;
            if (text.length > 4 * 1024 * 1024)
              r.destroy(new Error("response too large"));
          });
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode ?? 0,
                json: text ? JSON.parse(text) : undefined,
              });
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      r.on("timeout", () => r.destroy(new Error("egress control timed out")));
      r.on("error", reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  private async ok(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const r = await this.call(method, path, body);
    if (r.status >= 300)
      throw new Error(`egress ${method} ${path}: ${r.status}`);
    return r.json;
  }

  async setPolicy(ip: string, policy: EgressPolicy): Promise<void> {
    await this.ok("PUT", EGRESS_PATHS.policy(ip), policy);
  }
  async clearPolicy(ip: string): Promise<void> {
    await this.ok("DELETE", EGRESS_PATHS.policy(ip));
  }
  async list(): Promise<ListPoliciesResponse> {
    return ListPoliciesResponse.parse(
      await this.ok("GET", EGRESS_PATHS.policies),
    );
  }
  async restored(): Promise<void> {
    await this.ok("POST", EGRESS_PATHS.restored);
  }
  async health(): Promise<EgressHealth> {
    return EgressHealth.parse(await this.ok("GET", EGRESS_PATHS.health));
  }
  async denials(after: number): Promise<DenialsResponse> {
    return DenialsResponse.parse(
      await this.ok("GET", `${EGRESS_PATHS.denials}?after=${after}`),
    );
  }
}
