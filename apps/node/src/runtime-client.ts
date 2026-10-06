import {
  ComputerResponse,
  ConfigureResponse,
  RECORDING_FRAGMENTS_HEADER,
  RECORDING_LIMITS,
  RecordingFragments,
  RUNTIME_PATHS,
  RUNTIME_PORTS,
  ProbeResponse,
  RuntimeCaptcha,
  RuntimeHealth,
  type ComputerRequest,
  type ProbeRequest,
  type ConfigureRequest,
} from "@kestrel/contracts";

/**
 * The agent's calls into a container's control API (C5). Everything the container says is
 * untrusted (principle 2): every call has a timeout and a cap on the size of the response, and
 * every response is validated against its schema (threat model G-18).
 */
export interface RuntimeClient {
  health(
    address: string,
    token: string,
    timeoutMs?: number,
    /** Hold the answer until the browser is ready or failed, up to this long. */
    waitMs?: number,
  ): Promise<RuntimeHealth>;
  configure(
    address: string,
    token: string,
    req: ConfigureRequest,
    timeoutMs?: number,
  ): Promise<ConfigureResponse>;
  computer(
    address: string,
    token: string,
    req: ComputerRequest,
    timeoutMs?: number,
  ): Promise<ComputerResponse>;
  /**
   * The CAPTCHAs showing now (docs/lld/captcha.md). Null when the browser's `runtimed` predates
   * CAPTCHA detection (it answers 404).
   */
  captcha(
    address: string,
    token: string,
    timeoutMs?: number,
  ): Promise<RuntimeCaptcha | null>;
  /** W3: let the recorder write its last fragment before the container is removed. */
  stopRecording(
    address: string,
    token: string,
    timeoutMs?: number,
  ): Promise<void>;
  /**
   * A microVM's recording: the fragments after `after` (and an acknowledgement of those up to it).
   * The description is schema-checked and the body is exactly the size it claims, at most
   * `RECORDING_LIMITS.pullBytes`; the caller checks the rest (sequence, boxes). 404 is thrown as a
   * `RuntimeHttpError`.
   */
  recordingFragments(
    address: string,
    token: string,
    after: number,
    timeoutMs?: number,
  ): Promise<{ meta: RecordingFragments; body: Buffer }>;
  /** G-23: raw connections from inside a probe VM (a clone rekeyed as a probe). */
  probe(
    address: string,
    token: string,
    req: ProbeRequest,
    timeoutMs?: number,
  ): Promise<ProbeResponse>;
}

const MAX_RESPONSE_BYTES = 16 * 1024;
/** A full-page PNG of a 1920x1080 display, base64, with room to spare. */
const MAX_COMPUTER_RESPONSE_BYTES = 16 * 1024 * 1024;

async function readLimitedBytes(
  res: Response,
  max = MAX_RESPONSE_BYTES,
): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("the container's response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

async function readLimited(
  res: Response,
  max = MAX_RESPONSE_BYTES,
): Promise<string> {
  return (await readLimitedBytes(res, max)).toString("utf8");
}

/** A non-2xx answer, with its status. */
export class RuntimeHttpError extends Error {
  constructor(
    path: string,
    readonly status: number,
  ) {
    super(`runtime ${path}: ${status}`);
  }
}

/** fetch says only "fetch failed": the reason (ECONNREFUSED, a reset, a timeout) is in its cause. */
const detail = (path: string, e: unknown): Error => {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  return new Error(
    `runtime ${path}: ${cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e))}`,
  );
};

export class HttpRuntimeClient implements RuntimeClient {
  constructor(private readonly port: number = RUNTIME_PORTS.control) {}

  private async call<T>(
    address: string,
    token: string,
    method: "GET" | "POST",
    path: string,
    schema: { parse(v: unknown): T },
    body: unknown,
    timeoutMs: number,
    maxBytes = MAX_RESPONSE_BYTES,
    /** Safe to send twice (health, configure): retried once if the connection itself failed. */
    idempotent = false,
  ): Promise<T> {
    const send = () =>
      fetch(`http://${address}:${this.port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        // A container must not be able to send this root process to another address with a redirect.
        redirect: "error",
      });
    let res: Response;
    try {
      res = await send();
    } catch (e) {
      // Addresses are reused (a microVM's soon after the last one's): a kept-alive connection
      // to the previous browser at this address is dead, and the first request on it fails.
      if (!idempotent || !(e instanceof TypeError)) throw detail(path, e);
      res = await send().catch((e2: unknown) => {
        throw detail(path, e2);
      });
    }
    const text = await readLimited(res, maxBytes);
    if (!res.ok) throw new RuntimeHttpError(path, res.status);
    return schema.parse(JSON.parse(text));
  }

  async captcha(
    address: string,
    token: string,
    timeoutMs = 1000,
  ): Promise<RuntimeCaptcha | null> {
    try {
      return await this.call(
        address,
        token,
        "GET",
        RUNTIME_PATHS.captcha,
        RuntimeCaptcha,
        undefined,
        timeoutMs,
        MAX_RESPONSE_BYTES,
        true,
      );
    } catch (e) {
      if (e instanceof RuntimeHttpError && e.status === 404) return null;
      throw e;
    }
  }

  health(
    address: string,
    token: string,
    timeoutMs = 2000,
    waitMs = 0,
  ): Promise<RuntimeHealth> {
    // `wait` holds the answer until the browser is ready or failed (runtimed C5); an older
    // runtimed ignores it and answers at once, and the caller polls as before.
    return this.call(
      address,
      token,
      "GET",
      waitMs > 0
        ? `${RUNTIME_PATHS.health}?wait=${waitMs}`
        : RUNTIME_PATHS.health,
      RuntimeHealth,
      undefined,
      timeoutMs + waitMs,
      MAX_RESPONSE_BYTES,
      true,
    );
  }

  configure(
    address: string,
    token: string,
    req: ConfigureRequest,
    timeoutMs = 5000,
  ): Promise<ConfigureResponse> {
    return this.call(
      address,
      token,
      "POST",
      RUNTIME_PATHS.configure,
      ConfigureResponse,
      req,
      timeoutMs,
      MAX_RESPONSE_BYTES,
      true, // idempotent for the same proof (C5)
    );
  }

  computer(
    address: string,
    token: string,
    req: ComputerRequest,
    timeoutMs = 15_000,
  ): Promise<ComputerResponse> {
    return this.call(
      address,
      token,
      "POST",
      RUNTIME_PATHS.computer,
      ComputerResponse,
      req,
      timeoutMs,
      MAX_COMPUTER_RESPONSE_BYTES,
    );
  }

  async recordingFragments(
    address: string,
    token: string,
    after: number,
    timeoutMs = 5000,
  ): Promise<{ meta: RecordingFragments; body: Buffer }> {
    const path = `${RUNTIME_PATHS.recordingFragments}?after=${after}`;
    let res: Response;
    try {
      res = await fetch(`http://${address}:${this.port}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (e) {
      throw detail(path, e);
    }
    if (!res.ok) {
      await readLimited(res).catch(() => undefined);
      throw new RuntimeHttpError(path, res.status);
    }
    const raw = res.headers.get(RECORDING_FRAGMENTS_HEADER);
    if (!raw || raw.length > MAX_RESPONSE_BYTES) {
      await res.body?.cancel();
      throw new Error(`runtime ${path}: no valid description of the fragments`);
    }
    let meta: RecordingFragments;
    try {
      meta = RecordingFragments.parse(JSON.parse(raw));
    } catch {
      await res.body?.cancel();
      throw new Error(`runtime ${path}: the fragments' description is invalid`);
    }
    const expected = meta.fragments.reduce((n, f) => n + f.bytes, 0);
    if (expected > RECORDING_LIMITS.pullBytes) {
      await res.body?.cancel();
      throw new Error(
        `runtime ${path}: more fragments than one answer may hold`,
      );
    }
    const body = await readLimitedBytes(res, expected);
    if (body.length !== expected)
      throw new Error(`runtime ${path}: the body is not the size described`);
    return { meta, body };
  probe(
    address: string,
    token: string,
    req: ProbeRequest,
    // The targets run at once, each for at most 10 s.
    timeoutMs = 15_000,
  ): Promise<ProbeResponse> {
    return this.call(
      address,
      token,
      "POST",
      RUNTIME_PATHS.probe,
      ProbeResponse,
      req,
      timeoutMs,
      64 * 1024,
    );
  }

  async stopRecording(
    address: string,
    token: string,
    timeoutMs = 4000,
  ): Promise<void> {
    await this.call(
      address,
      token,
      "POST",
      RUNTIME_PATHS.recordingStop,
      { parse: (v: unknown) => v },
      undefined,
      timeoutMs,
    );
  }
}
