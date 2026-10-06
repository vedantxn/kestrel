import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  AGENT_STATE_PATH,
  ComputerAction,
  NODE_PATHS,
  SessionId,
  StartRequest,
  StopRequest,
} from "@kestrel/contracts";
import { z } from "zod";

const NodeComputerRequest = z.object({
  sessionId: SessionId,
  action: ComputerAction,
});
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
    if (!chunks.length) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      // Not the parser's message, which is logged: it can quote the input, and a start
      // request holds a proxy password (T-45).
      throw new Error("invalid JSON");
    }
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

      if (req.method === "GET" && path === AGENT_STATE_PATH)
        return send(res, 200, agent.state());
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
      if (req.method === "GET" && path.startsWith(`${NODE_PATHS.recording}/`)) {
        const sid = SessionId.safeParse(
          path.slice(NODE_PATHS.recording.length + 1),
        );
        if (!sid.success)
          return send(res, 400, { error: "invalid session id" });
        const rec = await agent.openRecording(sid.data);
        if (!rec) return send(res, 404, { error: "no recording" });
        res.writeHead(200, {
          "content-type": "video/mp4",
          "content-length": String(rec.size),
        });
        // Exactly the size measured when it was opened: a recorder still writing cannot make this unbounded.
        const stream = rec.fd.createReadStream({
          start: 0,
          end: Math.max(0, rec.size - 1),
        });
        stream.on("close", () => void rec.fd.close().catch(() => undefined));
        stream.on("error", () => res.destroy());
        if (rec.size === 0) {
          stream.destroy();
          return void res.end();
        }
        stream.pipe(res);
        return;
      }
      if (req.method === "POST" && path === NODE_PATHS.computer) {
        const parsed = NodeComputerRequest.safeParse(await readBody(req));
        if (!parsed.success)
          return send(res, 400, {
            error: parsed.error.issues[0]?.message ?? "invalid",
          });
        const r = await agent.computer(
          parsed.data.sessionId,
          parsed.data.action,
        );
        return r.ok
          ? send(res, 200, r.response)
          : send(res, r.status, { error: r.error });
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
