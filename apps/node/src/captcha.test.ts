import { describe, expect, it } from "vitest";
import type { Report, RuntimeCaptcha } from "@kestrel/contracts";
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
