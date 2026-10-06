import {
  CaptchaToken,
  type CaptchaSolverConfig,
  type CaptchaSolverService,
  type SolvableCaptchaProvider,
} from "@kestrel/contracts";
import { z } from "zod";

/**
 * CAPTCHA solver services (`docs/lld/captcha.md`, "Solver services"). The node agent asks one on
 * behalf of a session created with `captcha.solve`, with the deployment's own key; the key and
 * everything the service answers stay in this process's memory (T-61, T-63).
 *
 * The interface is one call, `solve`, so any other kind of service plugs in. The one
 * implementation speaks the `createTask` / `getTaskResult` protocol that CapSolver, 2Captcha and
 * Anti-Captcha share:
 *
 *   POST {base}/createTask     { clientKey, task }   -> { errorId, errorCode?, taskId }
 *   POST {base}/getTaskResult  { clientKey, taskId } -> { errorId, status, solution }
 *
 * Documentation (read 2026-10-06):
 *   CapSolver    https://docs.capsolver.com/en/guide/api-createtask/
 *                https://docs.capsolver.com/en/guide/api-gettaskresult/
 *                https://docs.capsolver.com/en/guide/captcha/ReCaptchaV2/
 *                https://docs.capsolver.com/en/guide/captcha/cloudflare_turnstile/
 *   2Captcha     https://2captcha.com/api-docs/recaptcha-v2
 *                https://2captcha.com/api-docs/cloudflare-turnstile
 *                https://2captcha.com/api-docs/get-task-result
 *   Anti-Captcha https://anti-captcha.com/apidoc/methods/getTaskResult
 *                https://anti-captcha.com/apidoc/task-types/TurnstileTaskProxyless
 * None of the three lists hCaptcha any more; `custom` (Anti-Captcha's task names at an
 * operator-given URL) is how a deployment can still solve it.
 */
export interface SolveTask {
  provider: SolvableCaptchaProvider;
  siteKey: string;
  /** Origin and path only. */
  pageUrl: string;
  invisible: boolean;
  action?: string;
  cdata?: string;
}

export type SolverFailure =
  "unsupported" | "solver_error" | "solver_unreachable" | "timeout";

export class SolverError extends Error {
  constructor(
    readonly kind: SolverFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface CaptchaSolver {
  /** A token for the task, or a `SolverError`. Never logs the key or the token. */
  solve(task: SolveTask, signal: AbortSignal): Promise<string>;
}

type TurnstileStyle = "capsolver" | "2captcha" | "anticaptcha";

interface Profile {
  base: string;
  /** Task type per provider; a provider missing here is `unsupported`. */
  types: Partial<Record<SolvableCaptchaProvider, string>>;
  /** Where Turnstile's action and cData go. */
  turnstile: TurnstileStyle;
  /** Wait before the first result request, and between them (the services' guidance). */
  firstPollMs: number;
  pollMs: number;
}

export const SERVICES: Record<CaptchaSolverService, Profile> = {
  capsolver: {
    base: "https://api.capsolver.com",
    types: {
      recaptcha: "ReCaptchaV2TaskProxyLess",
      turnstile: "AntiTurnstileTaskProxyLess",
    },
    turnstile: "capsolver",
    firstPollMs: 3000,
    pollMs: 3000,
  },
  "2captcha": {
    base: "https://api.2captcha.com",
    types: {
      recaptcha: "RecaptchaV2TaskProxyless",
      turnstile: "TurnstileTaskProxyless",
    },
    turnstile: "2captcha",
    firstPollMs: 5000,
    pollMs: 5000,
  },
  anticaptcha: {
    base: "https://api.anti-captcha.com",
    types: {
      recaptcha: "RecaptchaV2TaskProxyless",
      turnstile: "TurnstileTaskProxyless",
    },
    turnstile: "anticaptcha",
    firstPollMs: 5000,
    pollMs: 5000,
  },
  custom: {
    base: "",
    types: {
      recaptcha: "RecaptchaV2TaskProxyless",
      hcaptcha: "HCaptchaTaskProxyless",
      turnstile: "TurnstileTaskProxyless",
    },
    turnstile: "anticaptcha",
    firstPollMs: 3000,
    pollMs: 3000,
  },
};

/** A service's answers are third-party input: bounded, and only these shapes are read. */
const MAX_ANSWER_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const ErrorCode = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9_]*$/)
  .catch("?");
const Created = z.object({
  errorId: z.number().int(),
  errorCode: ErrorCode.optional(),
  taskId: z.union([z.string().min(1).max(128), z.number().int()]).optional(),
});
const Result = z.object({
  errorId: z.number().int(),
  errorCode: ErrorCode.optional(),
  status: z.string().max(32).optional(),
  solution: z
    .object({
      gRecaptchaResponse: z.string().optional(),
      token: z.string().optional(),
    })
    .optional(),
});

/** The task as the service wants it. */
export function taskFor(
  service: CaptchaSolverService,
  t: SolveTask,
): Record<string, unknown> | null {
  const p = SERVICES[service];
  const type = p.types[t.provider];
  if (!type) return null;
  const task: Record<string, unknown> = {
    type,
    websiteURL: t.pageUrl,
    websiteKey: t.siteKey,
  };
  if (t.provider !== "turnstile") {
    if (t.invisible) task.isInvisible = true;
    return task;
  }
  if (p.turnstile === "capsolver") {
    const metadata: Record<string, string> = {};
    if (t.action) metadata.action = t.action;
    if (t.cdata) metadata.cdata = t.cdata;
    if (Object.keys(metadata).length) task.metadata = metadata;
  } else {
    if (t.action) task.action = t.action;
    if (t.cdata) task[p.turnstile === "2captcha" ? "data" : "cData"] = t.cdata;
  }
  return task;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      throw new SolverError("solver_unreachable", "the answer is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The `createTask` protocol, for any of `SERVICES`. */
export class CreateTaskSolver implements CaptchaSolver {
  private readonly base: string;

  constructor(
    private readonly config: CaptchaSolverConfig,
    private readonly fetchFn: typeof fetch = fetch,
    /** Tests: shorter waits between result requests. */
    private readonly timing?: { firstPollMs: number; pollMs: number },
  ) {
    this.base = (config.url ?? SERVICES[config.service].base).replace(
      /\/+$/,
      "",
    );
  }

  private async post(
    path: string,
    body: object,
    signal: AbortSignal,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // The operator chose this address; a redirect must not take the key elsewhere.
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
    } catch {
      if (signal.aborted) throw new SolverError("timeout", "timed out");
      throw new SolverError("solver_unreachable", `${path}: unreachable`);
    }
    const text = await readBounded(res).catch((e: unknown) => {
      if (e instanceof SolverError) throw e;
      if (signal.aborted) throw new SolverError("timeout", "timed out");
      throw new SolverError("solver_unreachable", `${path}: read failed`);
    });
    if (!res.ok)
      throw new SolverError(
        "solver_unreachable",
        `${path}: HTTP ${res.status}`,
      );
    try {
      return JSON.parse(text);
    } catch {
      throw new SolverError("solver_unreachable", `${path}: not JSON`);
    }
  }

  async solve(t: SolveTask, signal: AbortSignal): Promise<string> {
    const profile = this.timing ?? SERVICES[this.config.service];
    const task = taskFor(this.config.service, t);
    if (!task)
      throw new SolverError(
        "unsupported",
        `${this.config.service} does not solve ${t.provider}`,
      );
    const clientKey = this.config.apiKey;
    const created = Created.safeParse(
      await this.post("/createTask", { clientKey, task }, signal),
    );
    if (!created.success)
      throw new SolverError(
        "solver_unreachable",
        "createTask: unexpected answer",
      );
    if (created.data.errorId !== 0 || created.data.taskId === undefined)
      throw new SolverError(
        "solver_error",
        `createTask: ${created.data.errorCode ?? "error"}`,
      );
    const taskId = created.data.taskId;
    await sleep(profile.firstPollMs, signal).catch(() => {
      throw new SolverError("timeout", "timed out");
    });
    for (;;) {
      const r = Result.safeParse(
        await this.post("/getTaskResult", { clientKey, taskId }, signal),
      );
      if (!r.success)
        throw new SolverError(
          "solver_unreachable",
          "getTaskResult: unexpected answer",
        );
      if (r.data.errorId !== 0)
        throw new SolverError(
          "solver_error",
          `getTaskResult: ${r.data.errorCode ?? "error"}`,
        );
      if (r.data.status === "ready") {
        const raw =
          t.provider === "turnstile"
            ? (r.data.solution?.token ?? r.data.solution?.gRecaptchaResponse)
            : (r.data.solution?.gRecaptchaResponse ?? r.data.solution?.token);
        const token = CaptchaToken.safeParse(raw);
        if (!token.success)
          throw new SolverError(
            "solver_unreachable",
            "getTaskResult: no usable token",
          );
        return token.data;
      }
      if (r.data.status !== "processing" && r.data.status !== "idle")
        throw new SolverError("solver_error", "getTaskResult: failed");
      await sleep(profile.pollMs, signal).catch(() => {
        throw new SolverError("timeout", "timed out");
      });
    }
  }
}

export function createSolver(config: CaptchaSolverConfig): CaptchaSolver {
  return new CreateTaskSolver(config);
}
