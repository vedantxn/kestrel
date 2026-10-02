import { ErrorResponse, ListEventsResponse, Session } from "@kestrel/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newUuid } from "./ids.js";
import { makeEnv, type Env } from "./test/harness.js";

let env: Env;
const reset = async (opts: Parameters<typeof makeEnv>[0] = {}) => {
  await env?.close();
  env = await makeEnv(opts);
};
afterAll(async () => env?.close());
beforeEach(() => reset());

/** Background work (a best-effort stop call) finishes soon after the request returns. */
async function eventually<T>(
  fn: () => Promise<T | false | undefined>,
  ms = 3000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const row = (id: string) =>
  env.call("GET", `/v1/sessions/${id}`).then((r) => Session.parse(r.json()));
const events = (id: string) =>
  env
    .call("GET", `/v1/sessions/${id}/events?limit=1000`)
    .then((r) => ListEventsResponse.parse(r.json()).data.map((e) => e.type));

describe("a lost stop message (K7)", () => {
  it("is repaired by the next heartbeat: the container is gone within one exchange", async () => {
    const s = Session.parse((await env.create()).json());
    env.failpoints.set("api.node_stop", "drop:once");
    expect(
      (await env.call("POST", `/v1/sessions/${s.id}/stop`)).statusCode,
    ).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(env.nodes.a!.stopCalls).toHaveLength(0); // the message never reached the node
    expect(env.nodes.a!.held.has(s.id)).toBe(true);

    env.clock.advance(2_000);
    const reply = await env.nodes.a!.sync(env.internal);
    expect(reply.stop).toEqual([{ sessionId: s.id, reason: "client_stop" }]);
    expect(env.nodes.a!.held.size).toBe(0);
    expect(await row(s.id)).toMatchObject({
      status: "stopped",
      endReason: "client_stop",
    });
  });

  it("is repaired by absence when the node holds nothing", async () => {
    const s = Session.parse((await env.create()).json());
    env.failpoints.set("api.node_stop", "drop:once");
    await env.call("POST", `/v1/sessions/${s.id}/stop`);
    env.nodes.a!.held.clear(); // the container vanished without a report
    env.clock.advance(1_000);
    await env.nodes.a!.heartbeat(env.internal);
    expect((await row(s.id)).status).toBe("stopping"); // too soon: that heartbeat may predate the stop
    env.clock.advance(5_000);
    await env.nodes.a!.heartbeat(env.internal);
    expect(await row(s.id)).toMatchObject({ status: "stopped" });
  });
});

describe("a lost start message", () => {
  it("ends the session cleanly and leaks nothing", async () => {
    env.failpoints.set("api.node_start", "drop:once");
    const res = await env.create();
    expect(res.statusCode).toBe(500);
    expect(ErrorResponse.parse(res.json()).error).toMatchObject({
      code: "internal",
      retryable: true,
    });
    const [only] = await env.db.session.findMany();
    const id = Session.parse(
      await env.call("GET", "/v1/sessions").then((r) => r.json().data[0]),
    ).id;
    await eventually(async () => (await row(id)).status === "failed");
    expect(await row(id)).toMatchObject({
      status: "failed",
      endReason: "start_timeout",
    });
    expect(only?.nodeId).toBe("a");
    expect(env.nodes.a!.held.size).toBe(0);
    // the slot is free again
    expect((await env.create()).statusCode).toBe(201);
  });

  it("stops an orphan the node did create after the answer was lost", async () => {
    env.nodes.a!.startMode = "late";
    const res = await env.create();
    expect(res.statusCode).toBe(500);
    const id = Session.parse(
      await env.call("GET", "/v1/sessions").then((r) => r.json().data[0]),
    ).id;
    // the API's own stop reaches the node, which does hold the container, so it is accepted
    await eventually(async () => env.nodes.a!.stopCalls.length === 1);
    expect(env.nodes.a!.startCalls).toHaveLength(1);
    await env.nodes.a!.flushReports(env.internal);
    expect(await row(id)).toMatchObject({
      status: "failed",
      endReason: "start_timeout",
    });
    expect(env.nodes.a!.held.size).toBe(0);
  });
});

describe("a start that does not succeed", () => {
  it("failed: ends runtime_crash", async () => {
    env.nodes.a!.startMode = "fail";
    const res = await env.create();
    expect(res.statusCode).toBe(500);
    const id = Session.parse(
      await env.call("GET", "/v1/sessions").then((r) => r.json().data[0]),
    ).id;
    await eventually(async () => (await row(id)).status === "failed");
    expect((await row(id)).endReason).toBe("runtime_crash");
  });

  it("unreachable: ends node_refused, as a retryable error", async () => {
    env.nodes.a!.startMode = "unreachable";
    const res = await env.create();
    expect(res.statusCode).toBe(500);
    expect(ErrorResponse.parse(res.json()).error.retryable).toBe(true);
    const id = Session.parse(
      await env.call("GET", "/v1/sessions").then((r) => r.json().data[0]),
    ).id;
    expect((await row(id)).endReason).toBe("node_refused");
  });

  it("refused: retried once on another node (K5)", async () => {
    await reset({
      nodes: [
        { id: "a", slots: 5 },
        { id: "b", slots: 5 },
      ],
    });
    env.nodes.a!.hotCount = 3; // a is preferred first
    await env.syncAll();
    env.nodes.a!.startMode = "refuse";
    const res = await env.create();
    expect(res.statusCode).toBe(201);
    const s = Session.parse(res.json());
    expect(s.nodeId).toBe("b");
    expect(env.nodes.a!.startCalls).toHaveLength(1);
    expect(env.nodes.b!.startCalls).toHaveLength(1);
    expect(await events(s.id)).toEqual([
      "session.requested",
      "session.scheduled",
      "session.starting",
      "session.scheduled",
      "session.ready",
    ]);
  });

  it("refused everywhere: 503, and the session ends node_refused", async () => {
    await reset({
      nodes: [
        { id: "a", slots: 5 },
        { id: "b", slots: 5 },
      ],
    });
    env.nodes.a!.startMode = "refuse";
    env.nodes.b!.startMode = "refuse";
    const res = await env.create();
    expect(res.statusCode).toBe(503);
    expect(ErrorResponse.parse(res.json()).error.code).toBe(
      "capacity_exhausted",
    );
    const id = Session.parse(
      await env.call("GET", "/v1/sessions").then((r) => r.json().data[0]),
    ).id;
    await eventually(async () => (await row(id)).status === "failed");
    expect((await row(id)).endReason).toBe("node_refused");
  });

  it("stopped while starting: the create fails and the session ends client_stop", async () => {
    env.nodes.a!.startMode = "hang";
    const creating = env.create();
    const id = await eventually(async () => {
      const list = (await env.call("GET", "/v1/sessions")).json().data;
      return list[0]?.id as string | undefined;
    });
    const stopped = await env.call("POST", `/v1/sessions/${id}/stop`);
    expect(stopped.statusCode).toBe(200);
    env.nodes.a!.unhang();
    const res = await creating;
    expect(res.statusCode).not.toBe(201);
    await env.nodes.a!.flushReports(env.internal);
    expect(await row(id)).toMatchObject({
      status: "stopped",
      endReason: "client_stop",
    });
    expect(env.nodes.a!.held.size).toBe(0);
  });
});

describe("a crash between reserving and starting (K9)", () => {
  it("is cleaned up by the sweeper within the start timeout and frees the slot", async () => {
    await reset({ nodes: [{ id: "a", slots: 1 }] });
    env.failpoints.set("api.create.after_reserve", "throw:once");
    const res = await env.create();
    expect(res.statusCode).toBe(500);
    const id = Session.parse(
      await env.call("GET", "/v1/sessions").then((r) => r.json().data[0]),
    ).id;
    expect(await row(id)).toMatchObject({ status: "scheduling" });
    expect((await env.create()).statusCode).toBe(503); // the slot is held by the stranded session

    env.clock.advance(46_000);
    await env.nodes.a!.heartbeat(env.internal);
    await env.sweeper.tick();
    await eventually(async () => (await row(id)).status === "failed");
    expect(await row(id)).toMatchObject({
      status: "failed",
      endReason: "start_timeout",
    });
    expect((await env.create()).statusCode).toBe(201);
  });

  it("returns the stranded session to a repeat of the same idempotency key", async () => {
    env.failpoints.set("api.create.after_reserve", "throw:once");
    expect((await env.create({ idempotencyKey: "crash" })).statusCode).toBe(
      500,
    );
    const again = await env.create({ idempotencyKey: "crash" });
    expect(again.statusCode).toBe(200);
    expect(Session.parse(again.json()).status).toBe("scheduling");
  });

  it("lets a repeat take over a key whose first request died before reserving", async () => {
    const projectId = env.projectId;
    await env.db.idempotencyKey.create({
      data: {
        id: newUuid(),
        projectId,
        key: "dead",
        requestHash: (await import("./idempotency.js")).requestHash(
          (await import("@kestrel/contracts")).SessionOptions.parse({}),
        ),
        sessionId: null,
        lockedUntil: new Date(env.clock.now() + 10_000),
        expiresAt: new Date(env.clock.now() + 86_400_000),
      },
    });
    const blocked = await env.create({ idempotencyKey: "dead" });
    expect(blocked.statusCode).toBe(409); // looks in progress
    env.clock.advance(11_000);
    await env.syncAll();
    expect((await env.create({ idempotencyKey: "dead" })).statusCode).toBe(201);
  });
});

describe("reconciling what the node holds", () => {
  it("tells a node to stop a session the API has no record of", async () => {
    const stray = "ses_" + "0".repeat(26);
    env.nodes.a!.held.set(stray, "ready");
    const reply = await env.nodes.a!.sync(env.internal);
    expect(reply.unknown).toEqual([stray]);
    expect(env.nodes.a!.held.has(stray)).toBe(false);
  });

  it("applies a repeated report once", async () => {
    const s = Session.parse((await env.create()).json());
    const a = env.nodes.a!;
    const r = a.report(s.id, {
      type: "egress.denied",
      data: {
        host: "169.254.169.254",
        port: 80,
        reason: "blocked_address",
        count: 3,
      },
    });
    await a.flushReports(env.internal);
    a.reports.push(r); // the node did not see the ack and resends
    await a.flushReports(env.internal);
    expect(
      (await events(s.id)).filter((t) => t === "egress.denied"),
    ).toHaveLength(1);
  });

  it("ignores a report about a session on another node", async () => {
    await reset({
      nodes: [
        { id: "a", slots: 5 },
        { id: "b", slots: 5 },
      ],
    });
    const s = Session.parse((await env.create()).json());
    const other = s.nodeId === "a" ? env.nodes.b! : env.nodes.a!;
    other.teardown(s.id, "oom");
    await other.flushReports(env.internal);
    expect((await row(s.id)).status).toBe("ready");
  });

  it("records a node-initiated end with its reason (deadline, crash, OOM)", async () => {
    const idle = Session.parse((await env.create()).json());
    const crashed = Session.parse((await env.create()).json());
    const oom = Session.parse((await env.create()).json());
    const a = env.nodes.a!;
    a.expire(idle.id, "idle_timeout");
    a.report(crashed.id, {
      type: "runtime.crashed",
      data: { process: "chrome", exitCode: 139, signal: null },
    });
    a.expire(crashed.id, "browser_crash");
    a.expire(oom.id, "oom");
    await a.flushReports(env.internal);
    expect(await row(idle.id)).toMatchObject({
      status: "timed_out",
      endReason: "idle_timeout",
      usage: { browserSeconds: 5 },
    });
    expect(await row(crashed.id)).toMatchObject({
      status: "failed",
      endReason: "browser_crash",
    });
    expect(await row(oom.id)).toMatchObject({
      status: "failed",
      endReason: "oom",
    });
    expect(await events(crashed.id)).toEqual([
      "session.requested",
      "session.scheduled",
      "session.starting",
      "session.ready",
      "runtime.crashed",
      "session.stopping",
      "session.ended",
    ]);
  });

  it("accepts reports for a session that has already ended, harmlessly", async () => {
    const s = Session.parse((await env.create()).json());
    env.nodes.a!.expire(s.id, "max_lifetime");
    await env.nodes.a!.flushReports(env.internal);
    env.nodes.a!.teardown(s.id, "oom"); // a stale duplicate with a different reason
    await env.nodes.a!.flushReports(env.internal);
    expect(await row(s.id)).toMatchObject({
      status: "timed_out",
      endReason: "max_lifetime",
    });
  });
});

describe("the node protocol endpoints", () => {
  it("refuse bad credentials and unknown nodes", async () => {
    const hb = env.nodes.a!.heartbeatBody();
    const noAuth = await env.internal.inject({
      method: "POST",
      url: "/internal/nodes/heartbeat",
      payload: hb,
    });
    expect(noAuth.statusCode).toBe(401);
    const wrong = await env.internal.inject({
      method: "POST",
      url: "/internal/nodes/heartbeat",
      payload: hb,
      headers: { authorization: "Bearer not-the-secret-0000000000" },
    });
    expect(wrong.statusCode).toBe(401);
    // node a's secret does not authenticate node b
    await reset({
      nodes: [
        { id: "a", slots: 1 },
        { id: "b", slots: 1 },
      ],
    });
    const asB = await env.internal.inject({
      method: "POST",
      url: "/internal/nodes/heartbeat",
      payload: { ...env.nodes.b!.heartbeatBody() },
      headers: { authorization: `Bearer ${env.nodes.a!.secret}` },
    });
    expect(asB.statusCode).toBe(401);
  });

  it("show active failpoints on the health endpoint (G-16)", async () => {
    expect(
      (await env.internal.inject({ method: "GET", url: "/healthz" })).json()
        .failpoints,
    ).toEqual({});
    env.failpoints.set("api.node_stop", "drop");
    expect(
      (await env.internal.inject({ method: "GET", url: "/healthz" })).json()
        .failpoints,
    ).toEqual({ "api.node_stop": "drop" });
  });

  it("serve metrics and readiness on the internal listener only", async () => {
    await env.create();
    const m = await env.internal.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toContain("kestrel_session_create_seconds");
    expect(m.body).toContain('kestrel_sessions{status="ready"} 1');
    expect(
      (await env.internal.inject({ method: "GET", url: "/readyz" })).statusCode,
    ).toBe(200);
    expect(
      (await env.api.inject({ method: "GET", url: "/metrics" })).statusCode,
    ).toBe(404);
    expect(
      (
        await env.api.inject({
          method: "POST",
          url: "/internal/nodes/heartbeat",
        })
      ).statusCode,
    ).toBe(404);
  });
});
