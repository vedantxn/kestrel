import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROOF_HEADER } from "@kestrel/contracts";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";

export type ContainerMode = "echo" | "stall";

/**
 * Stands in for a session container's CDP forward (R7): it refuses anything without the session
 * proof, serves Chrome-style discovery, and speaks a tiny echo protocol on its websockets.
 */
export class FakeContainer {
  server: Server;
  wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 512 * 1024 * 1024,
  });
  browserId = "B7F3A2C1-0000-4000-8000-000000000001";
  pageId = "PAGE0000000000000000000000000001";
  mode: ContainerMode = "echo";
  /** Every request seen: path and the proof header it carried. */
  requests: { path: string; proof: string | undefined; kind: "http" | "ws" }[] =
    [];
  sockets = new Set<WebSocket>();
  discoveryStatus = 200;

  constructor(readonly proof: string) {
    this.server = createServer((req, res) => {
      this.requests.push({
        path: req.url ?? "",
        proof: this.header(req),
        kind: "http",
      });
      if (this.header(req) !== this.proof) {
        res.writeHead(403);
        return res.end("bad proof");
      }
      if (this.discoveryStatus !== 200) {
        res.writeHead(this.discoveryStatus);
        return res.end();
      }
      const port = (this.server.address() as AddressInfo).port;
      const host = `127.0.0.1:${port}`;
      const page = {
        description: "",
        devtoolsFrontendUrl: `/devtools/inspector.html?ws=${host}/devtools/page/${this.pageId}`,
        id: this.pageId,
        title: "about:blank",
        type: "page",
        url: "about:blank",
        webSocketDebuggerUrl: `ws://${host}/devtools/page/${this.pageId}`,
      };
      res.setHeader("content-type", "application/json");
      const path = (req.url ?? "").replace(/\/$/, "");
      if (path === "/json/version") {
        return res.end(
          JSON.stringify({
            Browser: "Chrome/154.0.8037.92",
            "Protocol-Version": "1.3",
            "User-Agent": "Mozilla/5.0 test",
            webSocketDebuggerUrl: `ws://${host}/devtools/browser/${this.browserId}`,
          }),
        );
      }
      if (path === "/json/list" || path === "/json")
        return res.end(JSON.stringify([page]));
      res.writeHead(404);
      res.end();
    });
    this.server.on("upgrade", (req, socket, head) => {
      this.requests.push({
        path: req.url ?? "",
        proof: this.header(req),
        kind: "ws",
      });
      if (this.header(req) !== this.proof) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const ok =
        req.url === `/devtools/browser/${this.browserId}` ||
        req.url === `/devtools/page/${this.pageId}`;
      if (!ok) {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
  }

  private header(req: IncomingMessage): string | undefined {
    const v = req.headers[PROOF_HEADER];
    return Array.isArray(v) ? v[0] : v;
  }

  private onSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    if (this.mode === "stall") {
      ws.pause(); // never read: models a browser that has stopped draining
      return;
    }
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.send(data, { binary: true });
      const text = data.toString();
      try {
        const msg = JSON.parse(text) as {
          id?: number;
          method?: string;
          params?: { n?: number; size?: number };
        };
        if (msg.method === "Test.stream") {
          for (let i = 0; i < (msg.params?.n ?? 0); i++)
            ws.send(JSON.stringify({ method: "Test.event", params: { i } }));
          return ws.send(JSON.stringify({ id: msg.id, result: {} }));
        }
        if (msg.method === "Test.big") {
          return ws.send(
            JSON.stringify({
              id: msg.id,
              result: { blob: "x".repeat(msg.params?.size ?? 0) },
            }),
          );
        }
        ws.send(
          JSON.stringify({ id: msg.id, result: { echo: msg.method ?? null } }),
        );
      } catch {
        ws.send(data, { binary: false }); // not JSON: echo it untouched
      }
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return (this.server.address() as AddressInfo).port;
  }

  /** The container dies: every connection drops without a close handshake. */
  kill(): void {
    for (const s of this.sockets) s.terminate();
    this.server.closeAllConnections();
  }

  async stop(): Promise<void> {
    this.kill();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
