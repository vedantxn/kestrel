import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAPTCHA_SOLVE_LIMITS,
  type CaptchaSolverConfig,
  type Report,
  type RuntimeCaptcha,
  type RuntimeCaptchaChallenge,
} from "@kestrel/contracts";
import { solverUrlOk } from "./agent.js";
import { SolverError, type SolveTask } from "./solver.js";
import { Store } from "./store.js";
import { bootWithPool, makeRig, startReq, type Rig } from "./test/fakes.js";

type Ev = Extract<Report, { kind: "event" }>;
/** Every CAPTCHA event the agent queued: those already sent to the API and those still pending. */
const captchaEvents = (r: Rig): Ev["event"][] => {
  const all = new Map<string, Report>();
  for (const x of [...r.api.allReports, ...r.store.pendingReports(10_000)])
    all.set(x.id, x);
  return [...all.values()]
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
    .filter(
      (x): x is Ev => x.kind === "event" && x.event.type.startsWith("captcha."),
    )
    .map((x) => x.event);
};

const showing = (
  ...ds: [RuntimeCaptcha["detections"][number]["provider"], string | null][]
): RuntimeCaptcha => ({
  watching: true,
  detections: ds.map(([provider, host]) => ({ provider, host })),
});

async function started(r: Rig) {
  await bootWithPool(r);
  const req = startReq();
  await r.agent.start(req);
  const b = r.store.getBinding(req.sessionId)!;
  return { id: req.sessionId as string, address: b.address! };
}

describe("CAPTCHA polling on the node", () => {
  it("reports what appears and what goes, each event with the full set present", async () => {
    const r = makeRig({ poolTarget: 1 });
    const { id, address } = await started(r);
    await r.agent.pollCaptchas();
    expect(captchaEvents(r)).toEqual([]);

    r.runtime.captchaAnswers.set(
      address,
      showing(["recaptcha", "shop.example"], ["recaptcha", "other.example"]),
    );
    await r.agent.pollCaptchas();
    r.runtime.captchaAnswers.set(
      address,
      showing(["turnstile", "shop.example"], ["recaptcha", "shop.example"]),
    );
    await r.agent.pollCaptchas();
    r.runtime.captchaAnswers.set(address, showing(["datadome", null]));
    await r.agent.pollCaptchas();
    r.runtime.captchaAnswers.set(address, showing());
    await r.agent.pollCaptchas();

    expect(captchaEvents(r)).toEqual([
      {
        type: "captcha.detected",
        data: {
          provider: "recaptcha",
          host: "shop.example",
          present: ["recaptcha"],
        },
      },
      {
        type: "captcha.detected",
        data: {
          provider: "turnstile",
          host: "shop.example",
          present: ["recaptcha", "turnstile"],
        },
      },
      {
        type: "captcha.cleared",
        data: { provider: "recaptcha", present: ["turnstile"] },
      },
      { type: "captcha.cleared", data: { provider: "turnstile", present: [] } },
      {
        type: "captcha.detected",
        data: { provider: "datadome", host: null, present: ["datadome"] },
      },
      { type: "captcha.cleared", data: { provider: "datadome", present: [] } },
    ]);
    expect(r.store.getCaptcha(id)).toEqual([]);
  });

  it("reports nothing while unchanged, or while the browser is not watching", async () => {
    const r = makeRig({ poolTarget: 1 });
    const { address } = await started(r);
    r.runtime.captchaAnswers.set(address, showing(["hcaptcha", "a.example"]));
    await r.agent.pollCaptchas();
    await r.agent.pollCaptchas();
    r.runtime.captchaAnswers.set(address, { watching: false, detections: [] });
    await r.agent.pollCaptchas();
    expect(captchaEvents(r).map((e) => e.type)).toEqual(["captcha.detected"]);
  });

  it("stops asking a browser from before CAPTCHA detection, and backs off from one that fails", async () => {
    const r = makeRig({ poolTarget: 1 });
    const { address } = await started(r);
    const asked = () =>
      r.runtime.calls.filter((c) => c.op === "captcha" && c.address === address)
        .length;
    r.runtime.captchaAnswers.set(address, null);
    await r.agent.pollCaptchas();
    await r.agent.pollCaptchas();
    expect(asked()).toBe(1);

    const r2 = makeRig({ poolTarget: 1 });
    const s2 = await started(r2);
    r2.runtime.captchaAnswers.set(s2.address, "fail");
    for (let i = 0; i < 5; i++) await r2.agent.pollCaptchas();
    const n = r2.runtime.calls.filter((c) => c.op === "captcha").length;
    expect(n).toBe(3); // three in a row, then every 30 s
    r2.clock.advance(30_001);
    r2.runtime.captchaAnswers.set(s2.address, showing(["turnstile", null]));
    await r2.agent.pollCaptchas();
    expect(captchaEvents(r2).map((e) => e.type)).toEqual(["captcha.detected"]);
    expect(captchaEvents(r2)).toHaveLength(1);
  });

  it("asks only ready sessions' browsers, never pooled ones", async () => {
    const r = makeRig({ poolTarget: 2 });
    await bootWithPool(r);
    await r.agent.pollCaptchas();
    expect(r.runtime.calls.some((c) => c.op === "captcha")).toBe(false);
  });

  it("coalesces a page that keeps flapping, then reports the state it settles in", async () => {
    const r = makeRig({ poolTarget: 1 });
    const { id, address } = await started(r);
    for (let i = 0; i < 20; i++) {
      r.runtime.captchaAnswers.set(
        address,
        i % 2 ? showing() : showing(["recaptcha", "a.example"]),
      );
      await r.agent.pollCaptchas();
      r.clock.advance(2_000);
    }
    // 6 at once, then about one per 10 s: 40 s of flapping is at most 6 + 4 changes.
    const changes = captchaEvents(r).length;
    expect(changes).toBeGreaterThanOrEqual(6);
    expect(changes).toBeLessThanOrEqual(10);
    r.runtime.captchaAnswers.set(address, showing());
    for (let i = 0; i < 10; i++) {
      r.clock.advance(5_000);
      await r.agent.pollCaptchas();
    }
    expect(r.store.getCaptcha(id)).toEqual([]);
    expect(captchaEvents(r).at(-1)?.type).toBe("captcha.cleared");
  });

  it("keeps its state when the report queue is full, and reports once there is room", async () => {
    const r = makeRig({ poolTarget: 1 });
    const { id, address } = await started(r);
    for (
      let i = r.store.pendingReportCount();
      i < Store.MAX_PENDING_EVENTS;
      i++
    )
      r.store.enqueueReport((rid) => ({
        id: rid,
        at: new Date().toISOString(),
        kind: "event",
        sessionId: id as never,
        event: { type: "session.detached", data: { connections: 0 } },
      }));
    r.runtime.captchaAnswers.set(address, showing(["turnstile", null]));
    await r.agent.pollCaptchas();
    expect(r.store.getCaptcha(id)).toEqual([]);
    r.store.ackReports(r.store.pendingReports(10).map((x) => x.id));
    await r.agent.pollCaptchas();
    expect(r.store.getCaptcha(id)).toEqual(["turnstile"]);
  });

  it("does not report again after a restart, and forgets the state when the session ends", async () => {
    const r = makeRig({ poolTarget: 1 });
    const { id, address } = await started(r);
    r.runtime.captchaAnswers.set(address, showing(["recaptcha", "a.example"]));
    await r.agent.pollCaptchas();
    r.restart();
    await r.agent.boot();
    await r.agent.pollCaptchas();
    expect(captchaEvents(r)).toHaveLength(1);
    await r.agent.stop({ sessionId: id as never, reason: "client_stop" });
    await r.agent.idle();
    expect(r.store.getCaptcha(id)).toEqual([]);
    const n = r.store.db.prepare("SELECT COUNT(*) AS n FROM captcha").get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  it("does not move the idle deadline", async () => {
    const r = makeRig({ poolTarget: 1 });
    const { id, address } = await started(r);
    const idleAt = r.store.getBinding(id)!.idleAt;
    r.runtime.captchaAnswers.set(address, showing(["recaptcha", null]));
    r.clock.advance(1_000);
    await r.agent.pollCaptchas();
    expect(r.store.getBinding(id)!.idleAt).toBe(idleAt);
  });
});

const KEY = "solver-secret-key-0123456789";
const SITE_KEY = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI";
const challenge = (
  over: Partial<RuntimeCaptchaChallenge> = {},
): RuntimeCaptchaChallenge => ({
  id: "0123456789abcdef",
  provider: "recaptcha",
  siteKey: SITE_KEY,
  pageUrl: "https://shop.example/login",
  host: "shop.example",
  invisible: false,
  ...over,
});

/** A solver that records what it was asked and answers from `next`. */
class FakeSolver {
  asked: { config: CaptchaSolverConfig; task: SolveTask }[] = [];
  next: () => Promise<string> = async () => "03AF-solved_token";
  make = (config: CaptchaSolverConfig) => ({
    solve: (task: SolveTask) => {
      this.asked.push({ config, task });
      return this.next();
    },
  });
}

async function solving(
  solver: FakeSolver,
  config: CaptchaSolverConfig | null = { service: "2captcha", apiKey: KEY },
) {
  const r = makeRig({ poolTarget: 1 }, { solver: solver.make });
  await bootWithPool(r);
  const req = startReq(config ? { captcha: { solver: config } } : {});
  await r.agent.start(req);
  const b = r.store.getBinding(req.sessionId)!;
  return { r, id: req.sessionId as string, address: b.address! };
}

describe("CAPTCHA solving on the node", () => {
  it("asks the solver with the site key and page, puts the token in, and reports solving then solved", async () => {
    const solver = new FakeSolver();
    const { r, address } = await solving(solver);
    expect(r.runtime.calls.some((c) => c.op === "configure")).toBe(true);
    r.runtime.challengeAnswers.set(address, { challenges: [challenge()] });
    r.runtime.captchaAnswers.set(
      address,
      showing(["recaptcha", "shop.example"]),
    );
    await r.agent.pollCaptchas();
    await r.agent.idle();
    expect(solver.asked).toEqual([
      {
        config: { service: "2captcha", apiKey: KEY },
        task: {
          provider: "recaptcha",
          siteKey: SITE_KEY,
          pageUrl: "https://shop.example/login",
          invisible: false,
        },
      },
    ]);
    expect(r.runtime.injected).toEqual([
      { address, req: { id: "0123456789abcdef", token: "03AF-solved_token" } },
    ]);
    expect(captchaEvents(r)).toEqual([
      {
        type: "captcha.detected",
        data: {
          provider: "recaptcha",
          host: "shop.example",
          present: ["recaptcha"],
        },
      },
      {
        type: "captcha.solving",
        data: { provider: "recaptcha", host: "shop.example" },
      },
      {
        type: "captcha.solved",
        data: {
          provider: "recaptcha",
          host: "shop.example",
          durationMs: 0,
          callback: true,
        },
      },
    ]);
    // Nothing the agent queued or stored carries the key, the site key, the page's path or the token.
    const stored =
      JSON.stringify(r.store.pendingReports(10_000)) +
      JSON.stringify(r.api.allReports) +
      JSON.stringify(r.store.allBindings());
    for (const secret of [KEY, SITE_KEY, "/login", "03AF-solved_token"])
      expect(stored).not.toContain(secret);
    // The same widget, still present, is not solved again.
    await r.agent.pollCaptchas();
    await r.agent.idle();
    expect(solver.asked).toHaveLength(1);
  });

  it("solves nothing, and asks runtimed for nothing, for a session that did not ask", async () => {
    const solver = new FakeSolver();
    const { r, address } = await solving(solver, null);
    r.runtime.challengeAnswers.set(address, { challenges: [challenge()] });
    r.runtime.captchaAnswers.set(
      address,
      showing(["recaptcha", "shop.example"]),
    );
    await r.agent.pollCaptchas();
    await r.agent.idle();
    expect(solver.asked).toEqual([]);
    expect(r.runtime.calls.some((c) => c.op.startsWith("captchaC"))).toBe(
      false,
    );
    expect(captchaEvents(r).map((e) => e.type)).toEqual(["captcha.detected"]);
  });

  it.each([
    [
      "a provider the platform does not solve",
      "geetest",
      undefined,
      "unsupported",
    ],
    ["no details from runtimed", "recaptcha", { challenges: [] }, "no_details"],
    ["an older runtimed", "recaptcha", null, "runtime_unsupported"],
    [
      "a page URL with a query",
      "recaptcha",
      {
        challenges: [challenge({ pageUrl: "https://shop.example/login?s=1" })],
      },
      "no_details",
    ],
    [
      "a page URL on another host",
      "recaptcha",
      { challenges: [challenge({ pageUrl: "https://evil.example/" })] },
      "no_details",
    ],
  ] as const)(
    "fails over to a person for %s",
    async (_why, provider, answer, reason) => {
      const solver = new FakeSolver();
      const { r, address } = await solving(solver);
      if (answer !== undefined)
        r.runtime.challengeAnswers.set(address, answer as never);
      r.runtime.captchaAnswers.set(
        address,
        showing([provider, "shop.example"]),
      );
      await r.agent.pollCaptchas();
      await r.agent.idle();
      expect(solver.asked).toEqual([]);
      expect(captchaEvents(r).at(-1)).toEqual({
        type: "captcha.failed",
        data: { provider, host: "shop.example", reason },
      });
    },
  );

  it("reports the solver's failure, and an inject that found no widget", async () => {
    const solver = new FakeSolver();
    const { r, address } = await solving(solver);
    r.runtime.challengeAnswers.set(address, { challenges: [challenge()] });
    solver.next = () =>
      Promise.reject(
        new SolverError("solver_error", "createTask: ERROR_ZERO_BALANCE"),
      );
    r.runtime.captchaAnswers.set(
      address,
      showing(["recaptcha", "shop.example"]),
    );
    await r.agent.pollCaptchas();
    await r.agent.idle();
    expect(captchaEvents(r).at(-1)).toMatchObject({
      type: "captcha.failed",
      data: { reason: "solver_error" },
    });
    // It clears and comes back: tried again, and this time the widget is gone at inject.
    r.runtime.captchaAnswers.set(address, showing());
    await r.agent.pollCaptchas();
    solver.next = async () => "tok";
    r.runtime.injectAnswer = { result: "gone", callback: false };
    r.runtime.captchaAnswers.set(
      address,
      showing(["recaptcha", "shop.example"]),
    );
    await r.agent.pollCaptchas();
    await r.agent.idle();
    expect(solver.asked).toHaveLength(2);
    expect(captchaEvents(r).at(-1)).toMatchObject({
      type: "captcha.failed",
      data: { reason: "inject_failed" },
    });
  });

  it("stops at the per-session budget of solves", async () => {
    const solver = new FakeSolver();
    const { r, address } = await solving(solver);
    r.runtime.challengeAnswers.set(address, { challenges: [challenge()] });
    for (let i = 0; i < CAPTCHA_SOLVE_LIMITS.maxSolvesPerSession + 3; i++) {
      r.clock.advance(20_000); // past the event budget
      r.runtime.captchaAnswers.set(
        address,
        showing(["recaptcha", "shop.example"]),
      );
      await r.agent.pollCaptchas();
      await r.agent.idle();
      r.clock.advance(20_000);
      r.runtime.captchaAnswers.set(address, showing());
      await r.agent.pollCaptchas();
    }
    expect(solver.asked).toHaveLength(CAPTCHA_SOLVE_LIMITS.maxSolvesPerSession);
    expect(
      captchaEvents(r)
        .filter((e) => e.type === "captcha.failed")
        .at(-1),
    ).toMatchObject({
      data: { reason: "budget" },
    });
  });

  it("after an agent restart, knows a session asked to solve but has no key: no_solver", async () => {
    const solver = new FakeSolver();
    const { r, address } = await solving(solver);
    r.restart();
    await r.agent.boot();
    r.runtime.challengeAnswers.set(address, { challenges: [challenge()] });
    r.runtime.captchaAnswers.set(
      address,
      showing(["recaptcha", "shop.example"]),
    );
    await r.agent.pollCaptchas();
    await r.agent.idle();
    expect(solver.asked).toEqual([]);
    expect(captchaEvents(r).at(-1)).toMatchObject({
      type: "captcha.failed",
      data: { reason: "no_solver" },
    });
    // The store never held the key.
    expect(readFileSync(r.dbPath).includes(KEY)).toBe(false);
  });
});

describe("solverUrlOk", () => {
  it("lets only an origin and path on the reported host go to a solver", () => {
    expect(solverUrlOk("https://shop.example/login", "shop.example")).toBe(
      true,
    );
    expect(solverUrlOk("http://localhost:8000/a.html", "localhost")).toBe(true);
    expect(solverUrlOk("https://shop.example/login", null)).toBe(true);
    for (const [url, host] of [
      ["https://shop.example/login?x=1", "shop.example"],
      ["https://shop.example/login#f", "shop.example"],
      ["https://u:p@shop.example/", "shop.example"],
      ["https://other.example/", "shop.example"],
      ["file:///etc/passwd", null],
      ["javascript:alert(1)", null],
      ["https://shop.example/a b", "shop.example"],
    ] as const)
      expect(solverUrlOk(url, host)).toBe(false);
  });
});
