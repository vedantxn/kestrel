import {
  ComputerResponse,
  ConfigureResponse,
  RUNTIME_PATHS,
  RUNTIME_PORTS,
  RuntimeCaptcha,
  RuntimeHealth,
  type ComputerRequest,
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
}

const MAX_RESPONSE_BYTES = 16 * 1024;
/** A full-page PNG of a 1920x1080 display, base64, with room to spare. */
const MAX_COMPUTER_RESPONSE_BYTES = 16 * 1024 * 1024;

async function readLimited(
  res: Response,
  max = MAX_RESPONSE_BYTES,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
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
  return Buffer.concat(chunks).toString("utf8");
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
