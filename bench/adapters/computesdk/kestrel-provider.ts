/**
 * Kestrel (https://github.com/vedantxn/kestrel): open-source, self-hosted cloud browsers.
 *
 * The same shape as the `@computesdk/<provider>` browser packages the benchmark uses:
 * `kestrel({ apiKey, baseUrl }).session.create(opts)` returns `{ sessionId, connectUrl }` and
 * `.session.destroy(id)` releases it. No SDK dependency: two HTTP calls.
 *
 * `POST /v1/sessions` returns once the browser is ready; `connectUrl` is a wss:// CDP URL with
 * its token embedded. `POST /v1/sessions/{id}/stop` returns at once; teardown continues on the node.
 */
export interface KestrelOptions {
  apiKey: string;
  /** The deployment's public URL, e.g. https://browsers.example.com */
  baseUrl: string;
}

export function kestrel(o: KestrelOptions) {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the API's JSON, read field by field below
  ): Promise<any> => {
    const res = await fetch(new URL(path, o.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${o.apiKey}`,
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
  };

  return {
    session: {
      /**
       * Accepts Kestrel's session options (`viewport`, `timeout`, `recording`, ...). Options other
       * providers take (`stealth`, `region`, `proxies`, `headless`) are dropped: Kestrel refuses
       * unknown options rather than ignoring them.
       */
      async create(
        opts: Record<string, unknown> = {},
      ): Promise<{ sessionId: string; connectUrl: string }> {
        const known = [
          "timeout",
          "idleTimeout",
          "stopOnDisconnect",
          "viewport",
          "network",
          "metadata",
          "recording",
        ];
        const body: Record<string, unknown> = Object.fromEntries(
          Object.entries(opts).filter(([k]) => known.includes(k)),
        );
        // Kestrel's page can be at most 1920x1000: the 1920x1080 display also holds Chrome's toolbar.
        const v = body.viewport as
          { width: number; height: number } | undefined;
        if (v)
          body.viewport = {
            width: Math.min(v.width, 1920),
            height: Math.min(v.height, 1000),
          };
        // When every slot is busy, Kestrel answers 503 at once unless asked to wait: queue for a
        // slot, as a client of Kestrel would, so the wait shows up in creation time, not as a failure.
        body.waitForCapacityMs = Number(
          process.env.KESTREL_WAIT_FOR_CAPACITY_MS ?? 30_000,
        );
        const s = await call("POST", "/v1/sessions", body);
        if (!s?.id || !s?.connectUrl)
          throw new Error(
            `Invalid Kestrel session response (status ${s?.status})`,
          );
        return { sessionId: s.id, connectUrl: s.connectUrl };
      },
      async destroy(sessionId: string): Promise<void> {
        await call("POST", `/v1/sessions/${sessionId}/stop`);
      },
    },
  };
}
