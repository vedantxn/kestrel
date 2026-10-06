import {
  CAPTCHA_PROVIDERS,
  ListEventsResponse,
  Session,
  type CaptchaProvider,
  type Report,
} from "@kestrel/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Env as ApiEnv, loadSolver } from "./config.js";
import { CAPTCHA_LABELS, LIVE_PAGE } from "./live-page.js";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
beforeEach(async () => {
  await env?.close();
  env = await makeEnv({
    nodes: [
      { id: "a", slots: 5 },
      { id: "b", slots: 5 },
    ],
  });
});
afterAll(async () => env?.close());

const created = async () => Session.parse((await env.create()).json());
const get = async (id: string) =>
  Session.parse((await env.call("GET", `/v1/sessions/${id}`)).json());
const nodeOf = (s: Session) => env.nodes[s.nodeId as string]!;
const events = async (id: string) =>
  ListEventsResponse.parse(
    (await env.call("GET", `/v1/sessions/${id}/events`)).json(),
  ).data.filter((e) => e.type.startsWith("captcha."));

function detected(
  s: Session,
  provider: CaptchaProvider,
  present: CaptchaProvider[],
  host: string | null = "shop.example.com",
): Report {
  return nodeOf(s).report(s.id, {
    type: "captcha.detected",
    data: { provider, host, present },
  });
}
function cleared(
  s: Session,
  provider: CaptchaProvider,
  present: CaptchaProvider[],
): Report {
  return nodeOf(s).report(s.id, {
    type: "captcha.cleared",
    data: { provider, present },
  });
}

describe("Session.captcha follows the node's captcha events", () => {
  it("is set on detection, keeps its start while something stays present, and clears", async () => {
    const s = await created();
    expect(s.captcha).toBeNull();
    detected(s, "recaptcha", ["recaptcha"]);
    await nodeOf(s).flushReports(env.internal);
    const first = (await get(s.id)).captcha;
    expect(first?.providers).toEqual(["recaptcha"]);

    env.clock.advance(5_000);
    detected(s, "turnstile", ["recaptcha", "turnstile"]);
    await nodeOf(s).flushReports(env.internal);
    expect((await get(s.id)).captcha).toEqual({
      providers: ["recaptcha", "turnstile"],
      since: first!.since,
      solve: null,
    });

    cleared(s, "recaptcha", ["turnstile"]);
    cleared(s, "turnstile", []);
    await nodeOf(s).flushReports(env.internal);
    expect((await get(s.id)).captcha).toBeNull();
    expect((await events(s.id)).map((e) => e.type)).toEqual([
      "captcha.detected",
      "captcha.detected",
      "captcha.cleared",
      "captcha.cleared",
    ]);
    const first_event = (await events(s.id))[0]!;
    expect(first_event.data).toEqual({
      provider: "recaptcha",
      host: "shop.example.com",
      present: ["recaptcha"],
    });
  });

  it("is repaired by the next event when one was lost", async () => {
    const s = await created();
    detected(s, "recaptcha", ["recaptcha"]);
    await nodeOf(s).flushReports(env.internal);
    // The node dropped `cleared recaptcha`; the next event still says what is present.
    detected(s, "hcaptcha", ["hcaptcha"]);
    await nodeOf(s).flushReports(env.internal);
    expect((await get(s.id)).captcha?.providers).toEqual(["hcaptcha"]);
  });

  it("ignores a replayed report and a report from a node that does not hold the session", async () => {
    const s = await created();
    const r = detected(s, "recaptcha", ["recaptcha"]);
    await nodeOf(s).flushReports(env.internal);
    cleared(s, "recaptcha", []);
    await nodeOf(s).flushReports(env.internal);
    // The same detection again, under its original id: already applied, changes nothing.
    nodeOf(s).reports.push(r);
    await nodeOf(s).flushReports(env.internal);
    expect((await get(s.id)).captcha).toBeNull();

    const other = env.nodes[s.nodeId === "a" ? "b" : "a"]!;
    other.report(s.id, {
      type: "captcha.detected",
      data: { provider: "turnstile", host: null, present: ["turnstile"] },
    });
    await other.flushReports(env.internal);
    expect((await get(s.id)).captcha).toBeNull();
    expect(await events(s.id)).toHaveLength(2);
  });

  it("is null once the session stops, and a late report does not set it again", async () => {
    const s = await created();
    detected(s, "recaptcha", ["recaptcha"]);
    await nodeOf(s).flushReports(env.internal);
    await env.call("POST", `/v1/sessions/${s.id}/stop`);
    expect((await get(s.id)).captcha).toBeNull();
    detected(s, "hcaptcha", ["recaptcha", "hcaptcha"]);
    await nodeOf(s).flushReports(env.internal);
    const [row] = await env.db.session.findMany({ select: { captcha: true } });
    expect(row?.captcha).toBeNull();
    expect((await get(s.id)).captcha).toBeNull();
  });

  it("refuses a report whose host is not a bare hostname, at the schema (400)", async () => {
    const s = await created();
    const node = nodeOf(s);
    node.reports.push({
      id: "bad-1",
      at: new Date(env.clock.now()).toISOString(),
      kind: "event",
      sessionId: s.id,
      event: {
        type: "captcha.detected",
        data: {
          provider: "recaptcha",
          host: "EVIL/PATH",
          present: ["recaptcha"],
        },
      },
    } as never);
    await expect(node.flushReports(env.internal)).rejects.toThrow(/400/);
    node.reports = [];
    detected(s, "turnstile", ["turnstile"]);
    await node.flushReports(env.internal);
    expect((await get(s.id)).captcha?.providers).toEqual(["turnstile"]);
  });

  it("shows up in the session list too", async () => {
    const s = await created();
    detected(s, "datadome", ["datadome"]);
    await nodeOf(s).flushReports(env.internal);
    const list = (await env.call("GET", "/v1/sessions")).json() as {
      data: Session[];
    };
    expect(list.data.find((x) => x.id === s.id)?.captcha?.providers).toEqual([
      "datadome",
    ]);
  });
});

const SOLVER_KEY = "solver-key-do-not-leak-0123456789";

describe("CAPTCHA solving, opt-in per session", () => {
  const withSolver = async () => {
    await env.close();
    env = await makeEnv({
      captchaSolver: { service: "2captcha", apiKey: SOLVER_KEY },
    });
  };
  const solving = (s: Session, type: string, data: object): Report =>
    nodeOf(s).report(s.id, { type, data } as never);

  it("is refused when the deployment has no solver, and off by default", async () => {
    const res = await env.create({ captcha: { solve: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(String(res.body)).toMatch(/no CAPTCHA solver/);
    const s = await created();
    expect(s.options.captcha).toEqual({ solve: false });
    expect(env.nodes.a!.startCalls.at(-1)!.captcha).toBeUndefined();
  });

  it("sends the solver to the node in that session's start only, and stores or returns the key nowhere", async () => {
    await withSolver();
    const plain = await created();
    expect(env.nodes.a!.startCalls.at(-1)!.captcha).toBeUndefined();
    const res = await env.create({
      captcha: { solve: true },
      idempotencyKey: "solve-1",
    });
    expect(res.statusCode).toBe(201);
    const s = Session.parse(res.json());
    expect(s.options.captcha).toEqual({ solve: true });
    expect(env.nodes.a!.startCalls.at(-1)!.captcha).toEqual({
      solver: { service: "2captcha", apiKey: SOLVER_KEY },
    });
    expect(res.body).not.toContain(SOLVER_KEY);
    const rows = JSON.stringify(
      [
        await env.db.session.findMany(),
        await env.db.sessionEvent.findMany(),
        await env.db.idempotencyKey.findMany(),
      ],
      (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v),
    );
    expect(rows).not.toContain(SOLVER_KEY);
    expect(plain.options.captcha.solve).toBe(false);
  });

  it("puts the latest solve of something still present on the session", async () => {
    await withSolver();
    const s = Session.parse(
      (await env.create({ captcha: { solve: true } })).json(),
    );
    detected(s, "recaptcha", ["recaptcha"]);
    solving(s, "captcha.solving", {
      provider: "recaptcha",
      host: "shop.example.com",
    });
    await nodeOf(s).flushReports(env.internal);
    expect((await get(s.id)).captcha?.solve).toMatchObject({
      provider: "recaptcha",
      status: "solving",
      reason: null,
    });
    env.clock.advance(4_000);
    solving(s, "captcha.solved", {
      provider: "recaptcha",
      host: "shop.example.com",
      durationMs: 4000,
      callback: true,
    });
    await nodeOf(s).flushReports(env.internal);
    const solved = (await get(s.id)).captcha!;
    expect(solved.providers).toEqual(["recaptcha"]);
    expect(solved.solve).toEqual({
      provider: "recaptcha",
      status: "solved",
      at: new Date(env.clock.now()).toISOString(),
      reason: null,
    });
    // Another CAPTCHA appearing keeps the solve; the solved one going takes it away.
    detected(s, "geetest", ["recaptcha", "geetest"]);
    solving(s, "captcha.failed", {
      provider: "geetest",
      host: "shop.example.com",
      reason: "unsupported",
    });
    await nodeOf(s).flushReports(env.internal);
    expect((await get(s.id)).captcha?.solve).toMatchObject({
      provider: "geetest",
      status: "failed",
      reason: "unsupported",
    });
    cleared(s, "geetest", ["recaptcha"]);
    await nodeOf(s).flushReports(env.internal);
    expect((await get(s.id)).captcha).toMatchObject({
      providers: ["recaptcha"],
      solve: null,
    });
    // A solve event for something no longer present is on the timeline only.
    solving(s, "captcha.failed", {
      provider: "turnstile",
      host: null,
      reason: "inject_failed",
    });
    cleared(s, "recaptcha", []);
    await nodeOf(s).flushReports(env.internal);
    expect((await get(s.id)).captcha).toBeNull();
    expect((await events(s.id)).map((e) => e.type)).toEqual([
      "captcha.detected",
      "captcha.solving",
      "captcha.solved",
      "captcha.detected",
      "captcha.failed",
      "captcha.cleared",
      "captcha.failed",
      "captcha.cleared",
    ]);
  });

  it("refuses a solving report that carries more than the schema allows", async () => {
    const s = await created();
    const node = nodeOf(s);
    solving(s, "captcha.solving", { provider: "geetest", host: null });
    await expect(node.flushReports(env.internal)).rejects.toThrow(/400/);
  });
});

describe("the solver configuration", () => {
  it("reads the key from a file and names only the variable when something is wrong", () => {
    const read = () => " the-key \n";
    expect(loadSolver({}, read)).toBeUndefined();
    expect(
      loadSolver(
        { CAPTCHA_SOLVER: "capsolver", CAPTCHA_SOLVER_KEY_FILE: "/k" },
        read,
      ),
    ).toEqual({ service: "capsolver", apiKey: "the-key" });
    expect(() => loadSolver({ CAPTCHA_SOLVER: "capsolver" }, read)).toThrow(
      /CAPTCHA_SOLVER_KEY_FILE/,
    );
    expect(() =>
      loadSolver(
        { CAPTCHA_SOLVER: "custom", CAPTCHA_SOLVER_KEY_FILE: "/k" },
        read,
      ),
    ).toThrow(/url/);
    const bad = () =>
      loadSolver(
        { CAPTCHA_SOLVER: "capsolver", CAPTCHA_SOLVER_KEY_FILE: "/k" },
        () => "has a space secret",
      );
    expect(bad).toThrow(/apiKey/);
    expect(bad).not.toThrow(/secret/);
    // Compose passes unset variables as empty strings: that is no solver.
    const vars = ApiEnv.parse({
      DATABASE_URL: "postgresql://x",
      PUBLIC_HOSTNAME: "h",
      TOKEN_PRIVATE_KEY_FILE: "/k",
      KESTREL_NODES: "[]",
      CAPTCHA_SOLVER: "",
      CAPTCHA_SOLVER_URL: "",
      CAPTCHA_SOLVER_KEY_FILE: "/secrets/captcha-solver.key",
    });
    expect(vars.CAPTCHA_SOLVER).toBeUndefined();
    expect(loadSolver(vars, read)).toBeUndefined();
  });
});

describe("the live viewer's CAPTCHA banner", () => {
  it("has a fixed label for every provider, and writes text only", () => {
    expect(Object.keys(CAPTCHA_LABELS).sort()).toEqual(
      [...CAPTCHA_PROVIDERS].sort(),
    );
    for (const label of Object.values(CAPTCHA_LABELS))
      expect(LIVE_PAGE).toContain(JSON.stringify(label));
    expect(LIVE_PAGE).toContain('id="captcha" role="status" hidden');
    expect(LIVE_PAGE).not.toContain("innerHTML");
  });
});
