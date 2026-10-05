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
  LIMITS,
  RekeyRequest,
  RUNTIME_PATHS,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeCaptcha,
  RuntimeHealth,
} from "@kestrel/contracts";
import type { CaptchaWatcher } from "./captcha.js";
import { Cdp, getVersion, ViewportSizer } from "./cdp.js";
import type { CdpForward } from "./forward.js";
import { runComputer, type Tabs } from "./page.js";
import type { Recorder } from "./recorder.js";
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
 *  GET  /captcha    the known CAPTCHAs showing now (docs/lld/captcha.md)
 */
export class ControlServer {
  private server: Server | undefined;
  private configured: {
    proof: string;
    viewport: { width: number; height: number };
    response: ConfigureResponse;
  } | null = null;

  private rekeyed = false;

  constructor(
    private token: string,
    private readonly supervisor: Supervisor,
    private readonly forward: CdpForward,
    private readonly chromePort: number,
    private readonly tabs: Tabs,
    private readonly recorder?: Recorder,
    private readonly sizer = new ViewportSizer(chromePort),
    /** V7: this browser is a clone of a snapshot, started with the template's token. */
    private readonly snapshot = false,
    /** CAPTCHA detection, started once the container is bound to a session. */
    private readonly captcha?: CaptchaWatcher,
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
    this.sizer.close();
    this.captcha?.close();
    this.server?.closeAllConnections();
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
  }

  /**
   * V7. The page from the snapshot, and its renderer, exist in every clone: its JavaScript random
   * state (V8 seeds `Math.random` per renderer) would be the same in all of them. The session gets
   * a page made now instead, in a renderer made now (Chrome runs without a spare one in a snapshot),
   * sized like the old one.
   */
  private async freshPage(): Promise<void> {
    this.sizer.close();
    const v = await getVersion(this.chromePort);
    const cdp = await Cdp.connect(v.wsUrl);
    try {
      const { targetInfos } = await cdp.send<{
        targetInfos: { targetId: string; type: string }[];
      }>("Target.getTargets");
      await cdp.send("Target.createTarget", { url: "about:blank" });
      for (const t of targetInfos.filter((t) => t.type === "page"))
        await cdp.send("Target.closeTarget", { targetId: t.targetId });
    } finally {
      cdp.close();
    }
    this.tabs.current = null;
    await this.sizer.apply(LIMITS.defaultViewport);
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
        // `?wait=<ms>` (at most 10 s) holds the answer until the browser is ready or failed, so
        // the agent learns the moment it is ready instead of polling. Without it, answers at once.
        const wait = Number(
          new URL(req.url ?? "/", "http://runtime").searchParams.get("wait"),
        );
        if (Number.isFinite(wait) && wait > 0)
          await this.supervisor.settle(Math.min(wait, 10_000));
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
        const applied = await this.sizer.apply(viewport);
        const response = ConfigureResponse.parse(applied);
        this.configured = { proof: sessionProof, viewport, response };
        // Started after the viewport is applied, so the video is the window the caller asked for.
        if (parsed.data.recording) this.recorder?.start(applied.window);
        // Not awaited: detection must not slow a start (docs/lld/captcha.md).
        this.captcha?.start();
        return this.send(res, 200, response);
      }

      if (req.method === "POST" && path === RUNTIME_PATHS.rekey) {
        // Only a clone has a token to replace, and only once: from then on the template's is refused.
        if (!this.snapshot || this.rekeyed)
          return this.send(res, 409, { error: "nothing to rekey" });
        const parsed = RekeyRequest.safeParse(await this.body(req));
        if (!parsed.success)
          return this.send(res, 400, {
            error: parsed.error.issues[0]?.message ?? "invalid",
          });
        this.token = parsed.data.token;
        this.rekeyed = true;
        await this.freshPage();
        return this.send(res, 200, { ok: true });
      }

      if (req.method === "GET" && path === RUNTIME_PATHS.captcha) {
        if (!this.captcha) return this.send(res, 404, { error: "not found" });
        if (!this.configured)
          return this.send(res, 409, { error: "no session is bound" });
        return this.send(
          res,
          200,
          RuntimeCaptcha.parse(this.captcha.current()),
        );
      }

      if (req.method === "POST" && path === RUNTIME_PATHS.recordingStop) {
        await this.recorder?.stop();
        return this.send(res, 200, {
          state: this.recorder?.state ?? "idle",
        });
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
