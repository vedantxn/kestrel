import {
  ComputerResponse,
  NODE_PATHS,
  StartResponse,
  StopResponse,
  type ComputerRequest,
  type StartRequest,
  type StopRequest,
} from "@kestrel/contracts";
import type { NodeConfig } from "./config.js";

/** The API's side of the node protocol (C4): the fast path. */
export interface NodeClient {
  start(
    nodeId: string,
    req: StartRequest,
    timeoutMs: number,
  ): Promise<StartResponse>;
  stop(
    nodeId: string,
    req: StopRequest,
    timeoutMs: number,
  ): Promise<StopResponse>;
  /** W4. A refusal from the node (no such session, not running, the browser failed) is a result, not an error. */
  computer(
    nodeId: string,
    sessionId: string,
    action: ComputerRequest,
    timeoutMs: number,
  ): Promise<ComputerResult>;
}

export type ComputerResult =
  | { ok: true; response: ComputerResponse }
  | { ok: false; status: number; error: string };

/** The call failed or timed out: the node may or may not have acted. */
export class NodeCallError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "unreachable" | "bad_response",
  ) {
    super(message);
  }
}

export class HttpNodeClient implements NodeClient {
  constructor(private readonly nodes: Map<string, NodeConfig>) {}

  start(
    nodeId: string,
    req: StartRequest,
    timeoutMs: number,
  ): Promise<StartResponse> {
    return this.post(nodeId, NODE_PATHS.start, req, StartResponse, timeoutMs);
  }

  stop(
    nodeId: string,
    req: StopRequest,
    timeoutMs: number,
  ): Promise<StopResponse> {
    return this.post(nodeId, NODE_PATHS.stop, req, StopResponse, timeoutMs);
  }

  async computer(
    nodeId: string,
    sessionId: string,
    action: ComputerRequest,
    timeoutMs: number,
  ): Promise<ComputerResult> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new NodeCallError(`unknown node ${nodeId}`, "unreachable");
    let res: Response;
    try {
      res = await fetch(new URL(NODE_PATHS.computer, node.address), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${node.secret}`,
        },
        body: JSON.stringify({ sessionId, action }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new NodeCallError(`node ${nodeId}: unreachable`, "unreachable");
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok) {
      const parsed = ComputerResponse.safeParse(body);
      if (!parsed.success)
        throw new NodeCallError(`node ${nodeId}: bad response`, "bad_response");
      return { ok: true, response: parsed.data };
    }
    const error =
      typeof (body as { error?: unknown } | null)?.error === "string"
        ? (body as { error: string }).error.slice(0, 200)
        : `status ${res.status}`;
    return { ok: false, status: res.status, error };
  }

  private async post<T>(
    nodeId: string,
    path: string,
    body: unknown,
    schema: {
      safeParse(v: unknown): { success: true; data: T } | { success: false };
    },
    timeoutMs: number,
  ): Promise<T> {
    const node = this.nodes.get(nodeId);
    if (!node) throw new NodeCallError(`unknown node ${nodeId}`, "unreachable");
    let res: Response;
    try {
      res = await fetch(new URL(path, node.address), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${node.secret}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut =
        e instanceof Error &&
        (e.name === "TimeoutError" || e.name === "AbortError");
      throw new NodeCallError(
        `node ${nodeId}: ${timedOut ? "timed out" : "unreachable"}`,
        timedOut ? "timeout" : "unreachable",
      );
    }
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !parsed.success)
      throw new NodeCallError(
        `node ${nodeId}: bad response (${res.status})`,
        "bad_response",
      );
    return parsed.data;
  }
}
