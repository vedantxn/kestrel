import type { ProviderClient, ProviderSession } from "../types.js";
import { requireEnv } from "../utils/env.js";

/**
 * Kestrel (https://github.com/vedantxn/kestrel): open-source, self-hosted cloud browsers.
 *
 * KESTREL_URL     the deployment's public URL, e.g. https://browsers.example.com
 * KESTREL_API_KEY a project API key (ksl_...)
 *
 * `POST /v1/sessions` returns once the browser is ready, with `connectUrl`: a wss:// CDP URL
 * with its token embedded. `POST /v1/sessions/{id}/stop` returns at once; teardown continues
 * on the node. No SDK dependency: two HTTP calls.
 */
export class KestrelProvider implements ProviderClient {
  readonly name = "KESTREL";

  /**
   * Self-hosted, so there is no list price: this is infrastructure cost at stated density.
   * Default: an m7i.2xlarge (on-demand us-east-1, $0.4032/h) running 12 standard sessions,
   * billed per second. Override with KESTREL_COST_PER_HOUR.
   */
  computeCost(seconds: number): number {
    const perHour = Number(process.env.KESTREL_COST_PER_HOUR ?? 0.4032 / 12);
    return Math.round((seconds / 3600) * perHour * 1e8) / 1e8;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const res = await fetch(new URL(path, requireEnv("KESTREL_URL")), {
      method,
      headers: {
        authorization: `Bearer ${requireEnv("KESTREL_API_KEY")}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        `Kestrel ${method} ${path}: HTTP ${res.status} - ${text.slice(0, 300)}`,
      );
    return text ? JSON.parse(text) : undefined;
  }

  async create(opts?: { recording?: boolean }): Promise<ProviderSession> {
    // Default options, as the arena asks of every provider; `recording` maps to Kestrel's own option.
    const s = await this.call(
      "POST",
      "/v1/sessions",
      opts?.recording ? { recording: true } : {},
    );
    if (!s?.id || !s?.connectUrl)
      throw new Error(`Invalid Kestrel session response (status ${s?.status})`);
    return { id: s.id, cdpUrl: s.connectUrl };
  }

  async release(id: string): Promise<void> {
    await this.call("POST", `/v1/sessions/${id}/stop`);
  }
}
