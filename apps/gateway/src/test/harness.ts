import { newId, type Route } from "@kestrel/contracts";
import {
  FakeClock,
  TokenSigner,
  TokenVerifier,
  createLogger,
  generateTokenKeys,
} from "@kestrel/shared";
import WebSocket from "ws";
import { Gateway, type GatewayOptions } from "../gateway.js";
import { createGatewayMetrics } from "../metrics.js";
import { RouteTable } from "../routes.js";
import { FakeContainer } from "./fake-container.js";

export interface Session {
  id: string;
  projectId: string;
  container: FakeContainer;
  proof: string;
}

export interface Rig {
  gateway: Gateway;
  table: RouteTable;
  clock: FakeClock;
  port: number;
  host: string;
  signer: TokenSigner;
  metrics: ReturnType<typeof createGatewayMetrics>;
  attachments: { sessionId: string; connections: number }[][];
  addSession(opts?: { notAfterSec?: number }): Promise<Session>;
  token(
    s: Session | string,
    over?: {
      nod?: string;
      scope?: "cdp" | "view";
      deadlineMs?: number;
      project?: string;
    },
  ): Promise<string>;
  url(s: Session | string, token: string, path?: string): string;
  connect(
    s: Session,
    opts?: {
      token?: string;
      path?: string;
      bearer?: boolean;
      wsOpts?: ConstructorParameters<typeof WebSocket>[2];
    },
  ): Promise<WebSocket>;
  http(
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve with the first event of a websocket: open, or its close code. */
export function settle(
  ws: WebSocket,
): Promise<{ opened: boolean; code?: number; reason?: string }> {
  return new Promise((resolve) => {
    ws.once("open", () => resolve({ opened: true }));
    ws.once("close", (code, reason) =>
      resolve({ opened: false, code, reason: reason.toString() }),
    );
    ws.once("error", () => undefined);
  });
}

export function closeOf(
  ws: WebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED)
      return resolve({ code: 0, reason: "already closed" });
    ws.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
    ws.once("error", () => undefined);
  });
}

/** A websocket client that is open and ready to use, or throws with the close code it got. */
export function opened(ws: WebSocket): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("close", (code) => reject(new Error(`closed ${code} before open`)));
    ws.once("error", () => undefined);
  });
}

export function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (d) => resolve(d.toString()));
    ws.once("close", (c) =>
      reject(new Error(`closed ${c} while waiting for a message`)),
    );
  });
}

export async function makeRig(
  over: Partial<GatewayOptions> = {},
): Promise<Rig> {
  const keys = await generateTokenKeys();
  const signer = await TokenSigner.fromPem(keys.privatePem);
  const verifier = await TokenVerifier.fromPem(keys.publicPem);
  const clock = new FakeClock();
  const table = new RouteTable();
  const metrics = createGatewayMetrics();
  const attachments: Rig["attachments"] = [];
  const sessions: Session[] = [];
  const projectId = newId("prj");

  const gateway = new Gateway({
    nodeId: "a",
    publicHostname: "1-2-3-4.sslip.io",
    publicPort: 8443,
    verifier,
    table,
    log: createLogger("gateway-test", "silent"),
    metrics,
    tls: null,
    clock,
    onAttachments: (a) =>
      attachments.push(
        a.map((x) => ({ sessionId: x.sessionId, connections: x.connections })),
      ),
    ...over,
  });
  const addr = await gateway.start({ host: "127.0.0.1", port: 0 });
  const host = `127.0.0.1:${addr.port}`;

  const rig: Rig = {
    gateway,
    table,
    clock,
    port: addr.port,
    host,
    signer,
    metrics,
    attachments,
    async addSession(opts = {}) {
      const proof = Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex");
      const container = new FakeContainer(proof);
      const port = await container.start();
      const id = newId("ses");
      const route: Route = {
        sessionId: id as Route["sessionId"],
        projectId: projectId as Route["projectId"],
        address: "127.0.0.1",
        port,
        proof,
        notAfter: Math.floor(clock.now() / 1000) + (opts.notAfterSec ?? 3600),
      };
      table.put(route);
      const s = { id, projectId, container, proof };
      sessions.push(s);
      return s;
    },
    async token(s, o = {}) {
      const id = typeof s === "string" ? s : s.id;
      return signer.mint({
        sessionId: id,
        projectId:
          o.project ?? (typeof s === "string" ? projectId : s.projectId),
        nodeId: o.nod ?? "a",
        scope: o.scope ?? "cdp",
        deadlineMs: o.deadlineMs ?? clock.now() + 600_000,
        nowMs: clock.now(),
      });
    },
    url(s, token, path = "") {
      const id = typeof s === "string" ? s : s.id;
      return `ws://${host}/v1/sessions/${id}/cdp${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
    },
    async connect(s, o = {}) {
      const token = o.token ?? (await rig.token(s));
      const headers = o.bearer
        ? { authorization: `Bearer ${token}` }
        : undefined;
      const ws = new WebSocket(rig.url(s, o.bearer ? "" : token, o.path), {
        perMessageDeflate: false,
        headers,
        ...o.wsOpts,
      });
      return ws;
    },
    async http(path, headers = {}) {
      const res = await fetch(`http://${host}${path}`, { headers });
      return { status: res.status, body: await res.text() };
    },
    async close() {
      await gateway.stop(0).catch(() => undefined);
      for (const s of sessions) await s.container.stop().catch(() => undefined);
    },
  };
  return rig;
}
