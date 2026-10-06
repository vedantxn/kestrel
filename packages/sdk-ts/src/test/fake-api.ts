import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Session } from "../types.js";

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface Reply {
  status: number;
  /** JSON, or a Buffer sent as it is (as `video/mp4` unless a header says otherwise). */
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = Reply | ((req: Recorded) => Reply);

/**
 * A stand-in for the public API on a real local port, so the SDK's own `fetch`, headers,
 * timeouts and retries are all exercised. Each route answers with its replies in order and
 * then keeps repeating the last one.
 */
export async function fakeApi() {
  const requests: Recorded[] = [];
  const routes = new Map<string, Handler[]>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const text = Buffer.concat(chunks).toString();
      const rec: Recorded = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(rec);
      const queue = routes.get(`${rec.method} ${rec.path}`);
      const handler = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
      if (!handler)
        return send(res, {
          status: 404,
          body: apiError("not_found", "No such endpoint."),
        });
      send(res, typeof handler === "function" ? handler(rec) : handler);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(method: string, path: string, ...replies: Handler[]) {
      routes.set(`${method} ${path}`, replies);
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function send(res: ServerResponse, reply: Reply): void {
  const raw = Buffer.isBuffer(reply.body);
  res.writeHead(reply.status, {
    "content-type": raw ? "video/mp4" : "application/json",
    ...reply.headers,
  });
  if (raw) res.end(reply.body);
  else res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
}

const RETRYABLE: Record<string, boolean> = {
  quota_exceeded: true,
  capacity_exhausted: true,
  conflict: true,
  internal: true,
};

export function apiError(code: string, message: string, param?: string) {
  return {
    error: {
      code,
      message,
      retryable: RETRYABLE[code] ?? false,
      requestId: "req-1",
      ...(param ? { param } : {}),
    },
  };
}

export const SESSION_ID = "ses_01k6e4m9t8f2xq3w5y7z9a1b2c";

export function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    status: "ready",
    endReason: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    readyAt: "2026-10-03T10:00:01.200Z",
    endedAt: null,
    connectUrl: `wss://kestrel.test:443/v1/sessions/${SESSION_ID}/cdp?token=secret-token`,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    options: {
      timeout: 900_000,
      idleTimeout: 300_000,
      stopOnDisconnect: false,
      viewport: { width: 1280, height: 720 },
      network: {},
      recording: false,
      metadata: {},
      captcha: { solve: false },
    },
    nodeId: "a",
    startPath: "hot",
    usage: { browserSeconds: 0, egressBytesUp: 0, egressBytesDown: 0 },
    captcha: null,
    ...overrides,
  };
}
