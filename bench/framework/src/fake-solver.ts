import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in CAPTCHA solver service for `bench captcha` (`docs/lld/captcha.md`, "Tests"): the
 * `createTask` / `getTaskResult` protocol CapSolver, 2Captcha and Anti-Captcha share, with
 * Anti-Captcha's task names (the platform's `custom` service), so the whole solve path runs
 * without a paid account.
 *
 * Its tokens are the ones the providers' test keys accept: Google's test secret accepts any
 * reCAPTCHA token, hCaptcha's test secret only `10000000-aaaa-bbbb-cccc-000000000001`, and
 * Turnstile's test secrets the dummy token (all checked in the spike against siteverify). A page
 * whose path contains `solve-fail` is reported unsolvable. Each task answers `processing` once,
 * then `ready`.
 */
export const FAKE_TOKENS = {
  RecaptchaV2TaskProxyless: "03KESTREL-FAKE-recaptcha_token",
  HCaptchaTaskProxyless: "10000000-aaaa-bbbb-cccc-000000000001",
  TurnstileTaskProxyless: "XXXX.DUMMY.TOKEN.XXXX",
} as const;

export interface FakeTask {
  type: string;
  websiteURL: string;
  websiteKey: string;
  /** Every other field the platform sent, by name only. */
  fields: string[];
  clientKey: string;
}

export class FakeSolverService {
  private server: Server;
  readonly tasks: FakeTask[] = [];
  /** Every request body as received, for the leak sweep. */
  readonly bodies: string[] = [];
  private polls = new Map<number, number>();
  port = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<string> {
    await new Promise<void>((r) => this.server.listen(port, host, r));
    this.port = (this.server.address() as AddressInfo).port;
    return `http://${host}:${this.port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private send(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    this.bodies.push(text);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return this.send(res, { errorId: 1, errorCode: "ERROR_BAD_JSON" });
    }
    const clientKey = typeof body.clientKey === "string" ? body.clientKey : "";
    if (!clientKey)
      return this.send(res, {
        errorId: 1,
        errorCode: "ERROR_KEY_DOES_NOT_EXIST",
      });
    if (req.method === "POST" && req.url === "/createTask") {
      const t = (body.task ?? {}) as Record<string, unknown>;
      if (
        typeof t.type !== "string" ||
        !(t.type in FAKE_TOKENS) ||
        typeof t.websiteURL !== "string" ||
        typeof t.websiteKey !== "string"
      )
        return this.send(res, {
          errorId: 1,
          errorCode: "ERROR_TASK_NOT_SUPPORTED",
        });
      this.tasks.push({
        type: t.type,
        websiteURL: t.websiteURL,
        websiteKey: t.websiteKey,
        fields: Object.keys(t)
          .filter((k) => !["type", "websiteURL", "websiteKey"].includes(k))
          .sort(),
        clientKey,
      });
      return this.send(res, { errorId: 0, taskId: this.tasks.length });
    }
    if (req.method === "POST" && req.url === "/getTaskResult") {
      const id = Number(body.taskId);
      const task = this.tasks[id - 1];
      if (!task)
        return this.send(res, {
          errorId: 1,
          errorCode: "ERROR_NO_SUCH_CAPCHA_ID",
        });
      const n = (this.polls.get(id) ?? 0) + 1;
      this.polls.set(id, n);
      if (n === 1) return this.send(res, { errorId: 0, status: "processing" });
      if (task.websiteURL.includes("solve-fail"))
        return this.send(res, {
          errorId: 12,
          errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
          errorDescription: "Workers could not solve the Captcha",
        });
      const token = FAKE_TOKENS[task.type as keyof typeof FAKE_TOKENS];
      return this.send(res, {
        errorId: 0,
        status: "ready",
        solution:
          task.type === "TurnstileTaskProxyless"
            ? { token, userAgent: "fake" }
            : { gRecaptchaResponse: token },
        cost: "0",
      });
    }
    res.writeHead(404).end();
  }
}
