import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { NODE_PATHS, StartRequest, StopRequest } from "@kestrel/contracts";
import type { Logger } from "@kestrel/shared";
import type { NodeAgent } from "./agent.js";

const same = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );

/**
 * C4, K5, K6. The API's fast path into the agent: start, stop, describe. HTTP and JSON on
 * localhost, authenticated by this node's secret. A start can take as long as a cold browser
 * launch under load, so requests are allowed time (the API's own limit is 30 s).
 */
export function createNodeServer(
  agent: NodeAgent,
  secret: string,
  log: Logger,
): Server {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024) throw new Error("body too large");
      chunks.push(c as Buffer);
    }
    return chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : undefined;
  };

  const server = createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization;
      const presented =
        typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
          ? auth.slice(7).trim()
          : "";
      if (!presented || !same(presented, secret))
        return send(res, 401, { error: "unauthorized" });
      const path = new URL(req.url ?? "/", "http://node").pathname;

      if (req.method === "GET" && path === NODE_PATHS.describe)
        return send(res, 200, agent.describe());
      if (req.method === "POST" && path === NODE_PATHS.start) {
        const parsed = StartRequest.safeParse(await readBody(req));
        if (!parsed.success)
          return send(res, 400, {
            error: parsed.error.issues[0]?.message ?? "invalid",
          });
        return send(res, 200, await agent.start(parsed.data));
      }
      if (req.method === "POST" && path === NODE_PATHS.stop) {
        const parsed = StopRequest.safeParse(await readBody(req));
        if (!parsed.success)
          return send(res, 400, {
            error: parsed.error.issues[0]?.message ?? "invalid",
          });
        return send(res, 200, await agent.stop(parsed.data));
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "node request failed",
      );
      if (!res.headersSent) send(res, 500, { error: "internal" });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  return server;
}
