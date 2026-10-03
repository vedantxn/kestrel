import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  ComputerAction,
  ConfigureRequest,
  ConfigureResponse,
  RUNTIME_PATHS,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeHealth,
} from "@kestrel/contracts";
import { applyViewport } from "./cdp.js";
import type { CdpForward } from "./forward.js";
import { runComputer, type Tabs } from "./page.js";
import type { Supervisor } from "./supervisor.js";

const same = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );

/**
 * C5. The control API on port 9000, called only by the node agent and authenticated by the
 * per-container token it chose when it created the container.
 *
 *  GET  /health     status of the display and Chrome
 *  POST /configure  bind this container to a session: set the proof the CDP forward demands and
 *                   size the page to the requested viewport. Doubles as the agent's health check.
 */
export class ControlServer {
  private server: Server | undefined;
  private configured: {
    proof: string;
    viewport: { width: number; height: number };
    response: ConfigureResponse;
  } | null = null;

  constructor(
    private readonly token: string,
    private readonly supervisor: Supervisor,
    private readonly forward: CdpForward,
    private readonly chromePort: number,
    private readonly tabs: Tabs,
  ) {}

  async listen(port: number, host = "0.0.0.0"): Promise<number> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, resolve);
    });
    return (this.server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024) throw new Error("body too large"); // `/computer` text is up to 10,000 characters
      chunks.push(c as Buffer);
    }
    return chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
      : undefined;
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const auth = req.headers.authorization;
      const presented =
        typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
          ? auth.slice(7).trim()
          : "";
      if (!presented || !same(presented, this.token))
        return this.send(res, 401, { error: "unauthorized" });
      const path = new URL(req.url ?? "/", "http://runtime").pathname;

      if (req.method === "GET" && path === RUNTIME_PATHS.health) {
        return this.send(
          res,
          200,
          RuntimeHealth.parse({
            protocolVersion: RUNTIME_PROTOCOL_VERSION,
            status: this.supervisor.state,
            chromeReady: this.supervisor.chromeReady,
            chromeVersion: this.supervisor.chromeVersion,
          }),
        );
      }

      if (req.method === "POST" && path === RUNTIME_PATHS.configure) {
        const parsed = ConfigureRequest.safeParse(await this.body(req));
        if (!parsed.success)
          return this.send(res, 400, {
            error: parsed.error.issues[0]?.message ?? "invalid",
          });
        if (!this.supervisor.chromeReady)
          return this.send(res, 503, { error: "the browser is not ready" });
        const { sessionProof, viewport } = parsed.data;

        if (this.configured && !same(this.configured.proof, sessionProof)) {
          return this.send(res, 409, {
            error: "this container is bound to another session",
          });
        }
        if (!this.forward.setProof(sessionProof))
          return this.send(res, 409, {
            error: "this container is bound to another session",
          });
        const applied = await applyViewport(this.chromePort, viewport);
        const response = ConfigureResponse.parse(applied);
        this.configured = { proof: sessionProof, viewport, response };
        return this.send(res, 200, response);
      }

      if (req.method === "POST" && path === RUNTIME_PATHS.computer) {
        // Only a container bound to a session drives its page.
        if (!this.configured)
          return this.send(res, 409, { error: "no session is bound" });
        const parsed = ComputerAction.safeParse(await this.body(req));
        if (!parsed.success)
          return this.send(res, 400, {
            error: parsed.error.issues[0]?.message ?? "invalid",
          });
        return this.send(
          res,
          200,
          await runComputer(this.chromePort, this.tabs, parsed.data),
        );
      }

      this.send(res, 404, { error: "not found" });
    } catch (e) {
      this.send(res, 500, {
        error: e instanceof Error ? e.message.slice(0, 200) : "error",
      });
    }
  }
}
