import { describe, expect, it } from "vitest";
import {
  CreateTaskSolver,
  SERVICES,
  SolverError,
  taskFor,
  type SolveTask,
} from "./solver.js";

const RC: SolveTask = {
  provider: "recaptcha",
  siteKey: "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI",
  pageUrl: "https://shop.example/login",
  invisible: false,
};
const TS: SolveTask = {
  provider: "turnstile",
  siteKey: "0x4AAAAAAADnPIDROrmt1Wwj",
  pageUrl: "https://shop.example/login",
  invisible: false,
  action: "login",
  cdata: "abc123",
};
const KEY = "a-solver-key-0123456789";

/** Answers recorded from the services' documentation (see solver.ts for the pages). */
const RECORDED = {
  created: {
    errorId: 0,
    errorCode: "",
    errorDescription: "",
    taskId: "37223a89-06ed-442c-a0b8-22067b79c5b4",
  },
  processing: { errorId: 0, status: "processing" },
  readyRecaptcha: {
    errorId: 0,
    taskId: "37223a89-06ed-442c-a0b8-22067b79c5b4",
    solution: {
      userAgent: "xxx",
      gRecaptchaResponse:
        "03AGdBq25SxXT-pmSeBXjzScW-EiocHwwpwqtk1QXlJnGnUJCZrgjwLLdt7cb0",
    },
    status: "ready",
  },
  readyTurnstile: {
    errorId: 0,
    status: "ready",
    solution: {
      token:
        "0.zrSnRHO7h0HwSjSCU8oyzbjEtD8p.d62306d4ee00c77dda697f959ebbd7bd97",
      userAgent: "Mozilla/5.0",
    },
    cost: "0.00145",
  },
  zeroBalance: {
    errorId: 1,
    errorCode: "ERROR_ZERO_BALANCE",
    errorDescription: "Account has zero balance",
  },
  unsolvable: {
    errorId: 12,
    errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
    errorDescription: "Workers could not solve",
  },
};

interface Sent {
  url: string;
  body: Record<string, unknown>;
  redirect: string | undefined;
}

/** A fake fetch answering in turn from `answers`; records what was sent. */
function fakeFetch(answers: (unknown | ((s: Sent) => Response))[]) {
  const sent: Sent[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const s: Sent = {
      url,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
      redirect: init.redirect,
    };
    sent.push(s);
    const a = answers.shift();
    if (typeof a === "function") return (a as (s: Sent) => Response)(s);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, sent };
}

const fast = { firstPollMs: 1, pollMs: 1 };
const signal = () => AbortSignal.timeout(5000);

describe("the createTask solver", () => {
  it("creates the task, polls until ready, and returns the token", async () => {
    const f = fakeFetch([
      RECORDED.created,
      RECORDED.processing,
      RECORDED.readyRecaptcha,
    ]);
    const s = new CreateTaskSolver(
      { service: "capsolver", apiKey: KEY },
      f.fn,
      fast,
    );
    expect(await s.solve(RC, signal())).toBe(
      RECORDED.readyRecaptcha.solution.gRecaptchaResponse,
    );
    expect(f.sent.map((x) => x.url)).toEqual([
      "https://api.capsolver.com/createTask",
      "https://api.capsolver.com/getTaskResult",
      "https://api.capsolver.com/getTaskResult",
    ]);
    expect(f.sent[0]!.body).toEqual({
      clientKey: KEY,
      task: {
        type: "ReCaptchaV2TaskProxyLess",
        websiteURL: "https://shop.example/login",
        websiteKey: RC.siteKey,
      },
    });
    expect(f.sent[1]!.body).toEqual({
      clientKey: KEY,
      taskId: RECORDED.created.taskId,
    });
    expect(f.sent.every((x) => x.redirect === "error")).toBe(true);
  });

  it("names Turnstile's tasks and fields the way each service does", () => {
    expect(taskFor("capsolver", TS)).toEqual({
      type: "AntiTurnstileTaskProxyLess",
      websiteURL: TS.pageUrl,
      websiteKey: TS.siteKey,
      metadata: { action: "login", cdata: "abc123" },
    });
    expect(taskFor("2captcha", TS)).toEqual({
      type: "TurnstileTaskProxyless",
      websiteURL: TS.pageUrl,
      websiteKey: TS.siteKey,
      action: "login",
      data: "abc123",
    });
    expect(taskFor("anticaptcha", TS)).toEqual({
      type: "TurnstileTaskProxyless",
      websiteURL: TS.pageUrl,
      websiteKey: TS.siteKey,
      action: "login",
      cData: "abc123",
    });
    expect(taskFor("2captcha", { ...RC, invisible: true })).toEqual({
      type: "RecaptchaV2TaskProxyless",
      websiteURL: RC.pageUrl,
      websiteKey: RC.siteKey,
      isInvisible: true,
    });
    // None of the named services documents hCaptcha now; custom (Anti-Captcha's names) does.
    const hc = { ...RC, provider: "hcaptcha" as const };
    for (const s of ["capsolver", "2captcha", "anticaptcha"] as const)
      expect(taskFor(s, hc)).toBeNull();
    expect(taskFor("custom", hc)?.type).toBe("HCaptchaTaskProxyless");
    expect(SERVICES["2captcha"].base).toBe("https://api.2captcha.com");
    expect(SERVICES.anticaptcha.base).toBe("https://api.anti-captcha.com");
  });

  it("reads a Turnstile token from solution.token, at the operator's URL", async () => {
    const f = fakeFetch([{ errorId: 0, taskId: 7 }, RECORDED.readyTurnstile]);
    const s = new CreateTaskSolver(
      { service: "custom", url: "http://127.0.0.1:7390/", apiKey: KEY },
      f.fn,
      fast,
    );
    expect(await s.solve(TS, signal())).toBe(
      RECORDED.readyTurnstile.solution.token,
    );
    expect(f.sent[0]!.url).toBe("http://127.0.0.1:7390/createTask");
    expect(f.sent[1]!.body.taskId).toBe(7);
  });

  it.each([
    ["a refused task", [RECORDED.zeroBalance], "solver_error"],
    [
      "an unsolvable one",
      [RECORDED.created, RECORDED.unsolvable],
      "solver_error",
    ],
    [
      "a failed status",
      [RECORDED.created, { errorId: 0, status: "failed" }],
      "solver_error",
    ],
    ["no task id", [{ errorId: 0 }], "solver_error"],
    [
      "an unreachable service",
      [new TypeError("fetch failed")],
      "solver_unreachable",
    ],
    [
      "a server error",
      [() => new Response("oops", { status: 502 })],
      "solver_unreachable",
    ],
    [
      "not JSON",
      [() => new Response("<html>", { status: 200 })],
      "solver_unreachable",
    ],
    ["a wrong shape", [{ errorId: "0" }], "solver_unreachable"],
    [
      "an oversized answer",
      [() => new Response("x".repeat(70_000), { status: 200 })],
      "solver_unreachable",
    ],
    [
      "a token that could break out of a string",
      [
        RECORDED.created,
        {
          errorId: 0,
          status: "ready",
          solution: { gRecaptchaResponse: 'x");alert(1);//' },
        },
      ],
      "solver_unreachable",
    ],
    [
      "an empty token",
      [RECORDED.created, { errorId: 0, status: "ready", solution: {} }],
      "solver_unreachable",
    ],
  ])(
    "fails with a kind, never a token, for %s",
    async (_why, answers, kind) => {
      const f = fakeFetch(answers as unknown[]);
      const s = new CreateTaskSolver(
        { service: "2captcha", apiKey: KEY },
        f.fn,
        fast,
      );
      const e = await s.solve(RC, signal()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SolverError);
      expect((e as SolverError).kind).toBe(kind);
      // The message is safe to log: never the key.
      expect((e as Error).message).not.toContain(KEY);
    },
  );

  it("says unsupported without calling the service for a provider it cannot solve", async () => {
    const f = fakeFetch([]);
    const s = new CreateTaskSolver(
      { service: "capsolver", apiKey: KEY },
      f.fn,
      fast,
    );
    const e = await s
      .solve({ ...RC, provider: "hcaptcha" }, signal())
      .catch((x: unknown) => x);
    expect((e as SolverError).kind).toBe("unsupported");
    expect(f.sent).toEqual([]);
  });

  it("gives up with timeout when the deadline passes while polling", async () => {
    const answers: unknown[] = [RECORDED.created];
    for (let i = 0; i < 1000; i++) answers.push(RECORDED.processing);
    const f = fakeFetch(answers);
    const s = new CreateTaskSolver({ service: "2captcha", apiKey: KEY }, f.fn, {
      firstPollMs: 5,
      pollMs: 20,
    });
    const e = await s
      .solve(RC, AbortSignal.timeout(100))
      .catch((x: unknown) => x);
    expect((e as SolverError).kind).toBe("timeout");
  });
});
