import {
  HeartbeatResponse,
  NODE_PATHS,
  RegisterResponse,
  ReportsResponse,
  type HeartbeatRequest,
  type RegisterRequest,
  type ReportsRequest,
} from "@kestrel/contracts";
import type { ApiClient } from "./agent.js";

/** The agent's calls to the API's internal listener, authenticated by this node's secret (K6). */
export class HttpApiClient implements ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = 5000,
  ) {}

  private async post<T>(
    path: string,
    body: unknown,
    schema: { parse(v: unknown): T },
  ): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.secret}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
    return schema.parse(await res.json());
  }

  register(req: RegisterRequest) {
    return this.post(NODE_PATHS.register, req, RegisterResponse);
  }
  heartbeat(req: HeartbeatRequest) {
    return this.post(NODE_PATHS.heartbeat, req, HeartbeatResponse);
  }
  reports(req: ReportsRequest) {
    return this.post(NODE_PATHS.reports, req, ReportsResponse);
  }
}
