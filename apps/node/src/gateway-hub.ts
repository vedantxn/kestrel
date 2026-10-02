import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import {
  GatewayMessage,
  type AgentMessage,
  MAX_FRAME_BYTES,
  decodeLine,
  encodeLine,
  type Attachment,
  type Route,
} from "@kestrel/contracts";
import type { Logger } from "@kestrel/shared";

export interface HubOptions {
  log: Logger;
  /** The full route table, sent to a gateway when it connects. */
  routes: () => Route[];
  /** A gateway reported its attachments (on hello, and whenever they change). */
  onAttachments: (gatewayId: string, attachments: Attachment[]) => void;
  /** A gateway's connection closed: its attachments are gone (G12). */
  onGone: (gatewayId: string) => void;
}

/**
 * G12, C6. The agent's end of the node-local routing protocol. Each gateway connects to a Unix
 * socket; the agent sends it the full route table and then every change, and the gateway reports
 * its current attachments as full snapshots. If a connection closes, that gateway's attachments
 * are treated as gone, so a crashed gateway starts the idle timers instead of holding them
 * forever, and two gateways overlapping during a deploy each count correctly.
 */
export class GatewayHub {
  private server: Server | undefined;
  private clients = new Map<Socket, string | null>();

  constructor(private readonly o: HubOptions) {}

  async listen(
    path: string,
    owner?: { uid: number; gid: number },
  ): Promise<void> {
    if (existsSync(path)) unlinkSync(path);
    this.server = createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(path, resolve);
    });
    // Routes carry the session proof, so only the gateway's user may open this socket (threat model G-10).
    chmodSync(path, 0o600);
    if (owner) (await import("node:fs")).chownSync(path, owner.uid, owner.gid);
  }

  async close(): Promise<void> {
    for (const s of this.clients.keys()) s.destroy();
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
  }

  get connected(): number {
    return [...this.clients.values()].filter((id) => id !== null).length;
  }

  private accept(s: Socket): void {
    this.clients.set(s, null);
    s.on("error", () => undefined);
    const rl = createInterface({ input: s, crlfDelay: Infinity });
    rl.on("error", () => undefined);
    rl.on("line", (line) => {
      if (line.length > MAX_FRAME_BYTES) return s.destroy();
      const m = decodeLine(GatewayMessage, line);
      if (!m) {
        this.o.log.warn("ignoring a malformed message from a gateway");
        return;
      }
      if (m.type === "hello") {
        this.clients.set(s, m.gatewayId);
        s.write(
          encodeLine({
            type: "routes",
            routes: this.o.routes(),
          } satisfies AgentMessage),
        );
        this.o.onAttachments(m.gatewayId, m.attachments);
      } else {
        const id = this.clients.get(s);
        if (id) this.o.onAttachments(id, m.attachments);
      }
    });
    s.on("close", () => {
      const id = this.clients.get(s);
      this.clients.delete(s);
      rl.close();
      if (id) this.o.onGone(id);
    });
  }

  private broadcast(m: AgentMessage): void {
    const line = encodeLine(m);
    for (const [s, id] of this.clients) if (id) s.write(line);
  }

  putRoute(route: Route): void {
    this.broadcast({ type: "route.put", route });
  }

  removeRoute(sessionId: string): void {
    this.broadcast({
      type: "route.remove",
      sessionId: sessionId as Route["sessionId"],
    });
  }
}
