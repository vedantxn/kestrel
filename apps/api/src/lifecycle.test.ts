import { ListEventsResponse, Session, SessionEvent } from "@kestrel/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
beforeEach(async () => {
  await env?.close();
  env = await makeEnv();
});
afterAll(async () => env?.close());

describe("session lifecycle", () => {
  it("creates a ready session whose connect url carries a verifiable token", async () => {
    const res = await env.create({
      timeout: 60_000,
      viewport: { width: 1000, height: 600 },
    });
    expect(res.statusCode).toBe(201);
    const s = Session.parse(res.json());
    expect(s).toMatchObject({
      status: "ready",
      endReason: null,
      nodeId: "a",
      startPath: "hot",
      viewport: { width: 1000, height: 600 },
      options: {
        timeout: 60_000,
        idleTimeout: 300_000,
        stopOnDisconnect: false,
      },
    });
    const url = new URL(s.connectUrl as string);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("1-2-3-4.sslip.io:8443");
    expect(url.pathname).toBe(`/v1/sessions/${s.id}/cdp`);
    const verified = await env.verifier.verify(
      url.searchParams.get("token") as string,
      env.clock.now(),
    );
    expect(verified.ok && verified.claims.sub).toBe(s.id);
    expect(env.nodes.a!.startCalls).toHaveLength(1);
    expect(env.nodes.a!.startCalls[0]).toMatchObject({
      sessionId: s.id,
      timeoutMs: 60_000,
      epoch: 1,
    });
  });

  it("walks every status: ready, active, ready, stopping, stopped", async () => {
    const created = Session.parse((await env.create()).json());
    const a = env.nodes.a!;

    a.report(created.id, {
      type: "session.attached",
      data: { connections: 1 },
    });
    await a.flushReports(env.internal);
    expect(
      Session.parse(
        (await env.call("GET", `/v1/sessions/${created.id}`)).json(),
      ).status,
    ).toBe("active");

    a.report(created.id, {
      type: "session.detached",
      data: { connections: 0 },
    });
    await a.flushReports(env.internal);
    expect(
      Session.parse(
        (await env.call("GET", `/v1/sessions/${created.id}`)).json(),
      ).status,
    ).toBe("ready");

    const stop = await env.call("POST", `/v1/sessions/${created.id}/stop`);
    expect(stop.statusCode).toBe(200);
    expect(Session.parse(stop.json())).toMatchObject({
      status: "stopping",
      endReason: "client_stop",
      connectUrl: null,
    });
    expect(a.stopCalls).toHaveLength(1);

    await a.flushReports(env.internal);
    const done = Session.parse(
      (await env.call("GET", `/v1/sessions/${created.id}`)).json(),
    );
    expect(done).toMatchObject({
      status: "stopped",
      endReason: "client_stop",
      connectUrl: null,
    });
    expect(done.endedAt).not.toBeNull();

    const events = ListEventsResponse.parse(
      (await env.call("GET", `/v1/sessions/${created.id}/events`)).json(),
    );
    expect(events.data.map((e) => e.type)).toEqual([
      "session.requested",
      "session.scheduled",
      "session.starting",
      "session.ready",
      "session.attached",
      "session.detached",
      "session.stopping",
      "session.ended",
    ]);
    for (const e of events.data)
      expect(SessionEvent.safeParse(e).success).toBe(true);
  });
});
