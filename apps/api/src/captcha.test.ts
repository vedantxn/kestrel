import {
  CAPTCHA_PROVIDERS,
  ListEventsResponse,
  Session,
  type CaptchaProvider,
  type Report,
} from "@kestrel/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
