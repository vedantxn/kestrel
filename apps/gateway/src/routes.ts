import { readFileSync, watch } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import {
  AGENT_GATEWAY_PROTOCOL_VERSION,
  AgentMessage,
  MAX_FRAME_BYTES,
  Route,
  decodeLine,
  encodeLine,
  type Attachment,
  type GatewayMessage,
} from "@kestrel/contracts";
import type { Logger } from "@kestrel/shared";
import { z } from "zod";

export interface RouteEntry extends Route {
  /** The browser's own websocket path inside the container, learned from its /json/version. */
  browserPath?: string;
}

/**
 * The gateway's routing table (C6): session id to the container that serves it. It is replaced
 * wholesale by a snapshot from the node agent, and changed by single puts and removes. It
 * survives the agent going away: the data plane keeps working while the control plane is down.
 */
export class RouteTable {
  private routes = new Map<string, RouteEntry>();
  /** Called with the session ids whose routes just went away, so their connections can be closed. */
  onRemoved: (sessionIds: string[]) => void = () => undefined;

  get size(): number {
    return this.routes.size;
  }

  get(sessionId: string): RouteEntry | undefined {
    return this.routes.get(sessionId);
  }

  put(route: Route): void {
    const existing = this.routes.get(route.sessionId);
    // A changed address or proof is a different container: forget what was learned about the old one.
    const same =
      existing &&
      existing.address === route.address &&
      existing.port === route.port &&
      existing.proof === route.proof;
    this.routes.set(
      route.sessionId,
      same
        ? {
            ...route,
            ...(existing.browserPath
              ? { browserPath: existing.browserPath }
              : {}),
          }
        : { ...route },
    );
  }

  remove(sessionId: string): void {
    if (this.routes.delete(sessionId)) this.onRemoved([sessionId]);
  }

  /** Replace everything: what the agent says now is the truth. */
  replaceAll(routes: Route[]): void {
    const next = new Set<string>(routes.map((r) => r.sessionId));
    const gone = [...this.routes.keys()].filter((id) => !next.has(id));
    for (const r of routes) this.put(r);
    for (const id of gone) this.routes.delete(id);
    if (gone.length) this.onRemoved(gone);
  }

  ids(): string[] {
    return [...this.routes.keys()];
  }
}

/** A static routes file, for the first real connection before the node agent exists (WP3). */
export function watchRoutesFile(
  path: string,
  table: RouteTable,
  log: Logger,
): () => void {
  const load = (attempt = 0): void => {
    try {
      const routes = z
        .array(Route)
        .parse(JSON.parse(readFileSync(path, "utf8")));
      table.replaceAll(routes);
      log.info({ routes: routes.length }, "routes file loaded");
    } catch (e) {
      // The file may be half written; look again shortly before giving up.
      if (attempt < 5) return void setTimeout(() => load(attempt + 1), 100);
      log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "routes file not loaded",
      );
    }
  };
  load();
  const w = watch(path, { persistent: false }, () =>
    setTimeout(() => load(), 50),
  );
  return () => w.close();
}

export interface AgentClientOptions {
  socketPath: string;
  gatewayId: string;
  table: RouteTable;
  log: Logger;
  /** The current attachments, sent in the hello. */
  attachments: () => Attachment[];
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

/**
 * G12. The gateway connects to the node agent's Unix socket, sends a hello with its current
 * attachments, then receives the route table and changes to it. It reports its attachments as
 * full snapshots whenever they change. If the connection closes it reconnects with backoff and
 * keeps routing in the meantime.
 */
export class AgentClient {
  private socket: Socket | undefined;
  private stopped = false;
  private retry: NodeJS.Timeout | undefined;
  private delay: number;
  connected = false;

  constructor(private readonly o: AgentClientOptions) {
    this.delay = o.reconnectMinMs ?? 250;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.destroy();
  }

  /** Tell the agent the attachments changed. A no-op while disconnected: the hello carries them. */
  sendAttachments(attachments: Attachment[]): void {
    if (this.connected) this.write({ type: "attachments", attachments });
  }

  private write(m: GatewayMessage): void {
    this.socket?.write(encodeLine(m));
  }

  private connect(): void {
    if (this.stopped) return;
    const s = createConnection(this.o.socketPath);
    this.socket = s;
    s.on("connect", () => {
      this.connected = true;
      this.delay = this.o.reconnectMinMs ?? 250;
      this.write({
        type: "hello",
        protocolVersion: AGENT_GATEWAY_PROTOCOL_VERSION,
        gatewayId: this.o.gatewayId,
        attachments: this.o.attachments(),
      });
      this.o.log.info("connected to the node agent");
    });
    const rl = createInterface({ input: s, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.length > MAX_FRAME_BYTES) return s.destroy();
      const m = decodeLine(AgentMessage, line);
      if (!m) {
        this.o.log.warn("ignoring a malformed message from the agent");
        return;
      }
      switch (m.type) {
        case "routes":
          this.o.table.replaceAll(m.routes);
          break;
        case "route.put":
          this.o.table.put(m.route);
          break;
        case "route.remove":
          this.o.table.remove(m.sessionId);
          break;
      }
    });
    s.on("error", () => undefined); // handled by close
    rl.on("error", () => undefined); // readline re-emits its input's errors
    s.on("close", () => {
      rl.close();
      if (this.connected)
        this.o.log.warn(
          "lost the node agent; routing on with the routes it last sent",
        );
      this.connected = false;
      if (this.stopped) return;
      this.retry = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, this.o.reconnectMaxMs ?? 5_000);
    });
  }
}
