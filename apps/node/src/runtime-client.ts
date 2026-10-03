import {
  ComputerResponse,
  ConfigureResponse,
  RUNTIME_PATHS,
  RUNTIME_PORTS,
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
  ): Promise<T> {
    const res = await fetch(`http://${address}:${this.port}${path}`, {
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
    const text = await readLimited(res, maxBytes);
    if (!res.ok) throw new Error(`runtime ${path}: ${res.status}`);
    return schema.parse(JSON.parse(text));
  }

  health(
    address: string,
    token: string,
    timeoutMs = 2000,
  ): Promise<RuntimeHealth> {
    return this.call(
      address,
      token,
      "GET",
      RUNTIME_PATHS.health,
      RuntimeHealth,
      undefined,
      timeoutMs,
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
