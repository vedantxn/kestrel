import {
  NODE_PATHS,
  StartResponse,
  StopResponse,
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
}

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
