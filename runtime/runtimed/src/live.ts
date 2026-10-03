import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { LIVE_MODE_HEADER, type LiveMode } from "@kestrel/contracts";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import type { Cdp } from "./cdp.js";
import { PageDriver, openPage, type Tabs } from "./page.js";

/**
 * W2. Live view: CDP screencast frames to a viewer, and in `control` mode the viewer's input to
 * the page. Reached only through the CDP forward after it checked the session proof, so the
 * mode header was set by the gateway from a verified token.
 *
 * Flow control: Chrome sends the next frame only after the last one is acknowledged, and a
 * frame is acknowledged only once the viewer has drained its socket below `ackBelowBytes`. A slow
 * viewer therefore lowers the frame rate instead of building a backlog.
 */
export const LIVE_LIMITS = {
  ackBelowBytes: 512 * 1024,
  maxWidth: 1280,
  maxHeight: 720,
  quality: 60,
  maxViewerMessageBytes: 64 * 1024,
} as const;

const Coord = z.number().int().min(0).max(10_000);
const ViewerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tab"), id: z.string().min(1).max(128) }),
  z.object({
    type: z.literal("mouse"),
    action: z.enum(["down", "up", "move"]),
    x: Coord,
    y: Coord,
    button: z.enum(["left", "middle", "right"]).optional(),
  }),
  z.object({
    type: z.literal("wheel"),
    x: Coord,
    y: Coord,
    dx: z.number().int().min(-10_000).max(10_000),
    dy: z.number().int().min(-10_000).max(10_000),
  }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(32) }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(1000) }),
]);

export class LiveServer {
  private http: Server;
  private wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: LIVE_LIMITS.maxViewerMessageBytes,
  });
  /** Input that arrived on a view-only socket and was ignored. */
  ignoredInput = 0;

  constructor(
    private readonly chromePort: number,
    private readonly tabs: Tabs,
    private readonly log: (msg: string, extra?: object) => void = () =>
      undefined,
  ) {
    this.http = createServer((_req, res) => {
      res.writeHead(426).end();
    });
    this.http.on(
      "upgrade",
      (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const mode: LiveMode =
          req.headers[LIVE_MODE_HEADER] === "control" ? "control" : "view";
        this.wss.handleUpgrade(
          req,
          socket,
          head,
          (ws) => void this.serve(ws, mode),
        );
      },
    );
  }

  /** Take a connection from the CDP forward, with the bytes it already read put back. */
  accept(socket: Socket, alreadyRead: Buffer): void {
    socket.unshift(alreadyRead);
    this.http.emit("connection", socket);
    socket.resume();
  }

  private async serve(ws: WebSocket, mode: LiveMode): Promise<void> {
    let cdp: Cdp;
    let page: PageDriver;
    try {
      ({ cdp, page } = await openPage(this.chromePort, this.tabs));
    } catch (e) {
      this.log("live view could not reach the browser", { err: String(e) });
      ws.close(1011, "browser unreachable");
      return;
    }
    let closed = false;
    let waitTimer: NodeJS.Timeout | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(waitTimer);
      cdp.close();
      if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    };
    ws.on("close", close);
    ws.on("error", close);
    cdp.onClose(close);

    const sendTabs = async (): Promise<void> => {
      try {
        const tabs = await this.tabs.list(cdp);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "tabs", tabs }));
      } catch {
        /* the browser is going away */
      }
    };

    const start = async (p: PageDriver): Promise<void> => {
      await p.send("Page.enable");
      await p.send("Page.startScreencast", {
        format: "jpeg",
        quality: LIVE_LIMITS.quality,
        maxWidth: LIVE_LIMITS.maxWidth,
        maxHeight: LIVE_LIMITS.maxHeight,
        everyNthFrame: 1,
      });
    };

    const ack = (frameSession: number): void => {
      const done = (): void =>
        void page
          .send("Page.screencastFrameAck", { sessionId: frameSession })
          .catch(() => undefined);
      if (ws.bufferedAmount < LIVE_LIMITS.ackBelowBytes) return done();
      clearInterval(waitTimer);
      waitTimer = setInterval(() => {
        if (closed) return clearInterval(waitTimer);
        if (ws.bufferedAmount < LIVE_LIMITS.ackBelowBytes) {
          clearInterval(waitTimer);
          done();
        }
      }, 50);
    };

    let tabsTimer: NodeJS.Timeout | undefined;
    cdp.onEvent((e) => {
      if (
        e.method === "Page.screencastFrame" &&
        e.sessionId === page.sessionId
      ) {
        const p = e.params as {
          data: string;
          sessionId: number;
          metadata: { deviceWidth: number; deviceHeight: number };
        };
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: "frame",
              data: p.data,
              width: Math.round(p.metadata.deviceWidth),
              height: Math.round(p.metadata.deviceHeight),
            }),
          );
        ack(p.sessionId);
      } else if (e.method.startsWith("Target.target")) {
        // Debounced: opening a tab fires several of these at once.
        clearTimeout(tabsTimer);
        tabsTimer = setTimeout(() => void sendTabs(), 200);
        if (
          e.method === "Target.targetDestroyed" &&
          (e.params as { targetId?: string }).targetId === page.targetId
        )
          void switchTo(null);
      }
    });

    const switchTo = async (id: string | null): Promise<void> => {
      const list = await this.tabs.list(cdp);
      if (id && !list.some((t) => t.id === id)) return;
      this.tabs.current = id;
      const next = this.tabs.pick(list.map((t) => t.id));
      if (!next || next === page.targetId) return;
      await page.send("Page.stopScreencast").catch(() => undefined);
      await page.detach();
      page = await PageDriver.attach(cdp, next);
      await start(page);
      await sendTabs();
    };

    ws.on("message", (raw) => {
      let msg: z.infer<typeof ViewerMessage>;
      try {
        msg = ViewerMessage.parse(JSON.parse(raw.toString()));
      } catch {
        return; // a malformed message is dropped, not fatal
      }
      if (msg.type === "tab") {
        void switchTo(msg.id).catch(() => undefined);
        return;
      }
      if (mode !== "control") {
        this.ignoredInput++;
        return;
      }
      const run = (): Promise<void> => {
        switch (msg.type) {
          case "mouse":
            return page.mouse(msg.action, msg.x, msg.y, msg.button ?? "left");
          case "wheel":
            return page.wheel(msg.x, msg.y, msg.dx, msg.dy);
          case "key":
            return page.key(msg.key);
          case "text":
            return page.text(msg.text);
        }
      };
      void run().catch(() => undefined);
    });

    try {
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      await start(page);
      await sendTabs();
    } catch (e) {
      this.log("live view could not start", { err: String(e) });
      close();
    }
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }
}
