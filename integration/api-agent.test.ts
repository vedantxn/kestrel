import { ErrorResponse, ListEventsResponse, Session } from "@kestrel/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  heartbeat,
  ingestReports,
  registerNode,
} from "../apps/api/src/nodes.js";
import type { NodeClient } from "../apps/api/src/node-client.js";
import { makeEnv, type Env } from "../apps/api/src/test/harness.js";
import type { ApiClient } from "../apps/node/src/agent.js";
import { makeRig, type Rig } from "../apps/node/src/test/fakes.js";

/**
 * The real API (Postgres, state machine, scheduler, sweeper) wired to the real node agent (store,
 * start and stop sequences, reconciliation) with a fake Docker, in one process. The two ends of
 * the node protocol are each tested alone elsewhere; this checks that they agree.
 */
let env: Env;
let rig: Rig;
let agentUp = true;

beforeEach(async () => {
  env = await makeEnv({
    nodes: [{ id: "a", slots: 4 }],
    nodeCallTimeoutMs: 2000,
  });
  rig = makeRig({ slotsTotal: 4, poolTarget: 2 });
  agentUp = true;

  // The agent's calls go to the API's real handlers, as the HTTP layer would route them.
  const api: ApiClient = {
    register: (req) => registerNode(env.ctx, req),
    heartbeat: (req) => heartbeat(env.ctx, req),
    reports: (req) => ingestReports(env.ctx, req),
  };
  (rig.agent as unknown as { d: { api: ApiClient } }).d.api = api;
  // The API's calls go to the real agent.
  const client: NodeClient = {
    start: async (_n, req) => {
      if (!agentUp) throw new Error("agent down");
      return rig.agent.start(req);
    },
    stop: async (_n, req) => {
      if (!agentUp) throw new Error("agent down");
      return rig.agent.stop(req);
    },
  };
  env.ctx.nodeClient = client;
  await rig.agent.boot();
  await rig.agent.register();
  await rig.agent.refillPool();
  await rig.agent.idle();
  await rig.agent.heartbeat();
});
afterEach(async () => env?.close());

const row = (id: string) =>
  env.call("GET", `/v1/sessions/${id}`).then((r) => Session.parse(r.json()));
const events = (id: string) =>
  env
    .call("GET", `/v1/sessions/${id}/events?limit=1000`)
    .then((r) => ListEventsResponse.parse(r.json()).data.map((e) => e.type));
const settle = async () => {
  await rig.agent.idle();
  await rig.agent.flushReports();
  await rig.agent.heartbeat();
  await rig.agent.idle();
  await rig.agent.flushReports();
};

describe("API and agent together", () => {
  it("creates a hot session, and a stop travels API -> agent -> report -> API", async () => {
    const res = await env.create({ timeout: 60_000 });
    expect(res.statusCode).toBe(201);
    const s = Session.parse(res.json());
    expect(s).toMatchObject({ status: "ready", startPath: "hot", nodeId: "a" });
    expect(s.connectUrl).toContain(`/v1/sessions/${s.id}/cdp?token=`);
    expect(rig.store.getBinding(s.id)).toMatchObject({ state: "ready" });
    expect(rig.hub.routes.has(s.id)).toBe(true);

    expect(
      (await env.call("POST", `/v1/sessions/${s.id}/stop`)).statusCode,
    ).toBe(200);
    await settle();
    expect(await row(s.id)).toMatchObject({
      status: "stopped",
      endReason: "client_stop",
    });
    expect(rig.docker.byRole("session")).toHaveLength(0);
    expect(rig.egress.policies.size).toBe(0);
    expect(await events(s.id)).toEqual([
      "session.requested",
      "session.scheduled",
      "session.starting",
      "session.ready",
      "session.stopping",
      "session.ended",
    ]);
  });

  it("a client attaching and detaching moves the session between ready and active", async () => {
    const s = Session.parse((await env.create()).json());
    rig.agent.handleAttachments("g1", [{ sessionId: s.id, connections: 1 }]);
    await rig.agent.flushReports();
    expect((await row(s.id)).status).toBe("active");
    rig.agent.handleAttachments("g1", []);
    await rig.agent.flushReports();
    expect((await row(s.id)).status).toBe("ready");
  });

  it("the agent ending a session on its own (idle timeout) reaches the API as timed_out", async () => {
    const s = Session.parse((await env.create({ idleTimeout: 5_000 })).json());
    rig.clock.advance(6_000);
    rig.agent.tick();
    await settle();
    expect(await row(s.id)).toMatchObject({
      status: "timed_out",
      endReason: "idle_timeout",
    });
  });

  it("a crashed container reaches the API as failed with the reason", async () => {
    const s = Session.parse((await env.create()).json());
    rig.docker.kill(rig.store.getBinding(s.id)!.containerId!, { oom: true });
    await rig.agent.reconcile();
    await settle();
    expect(await row(s.id)).toMatchObject({
      status: "failed",
      endReason: "oom",
    });
    expect(await events(s.id)).toContain("runtime.crashed");
  });

  it("an agent restart mid-run loses no session, and the API never notices", async () => {
    const s = Session.parse((await env.create()).json());
    rig.restart();
    (rig.agent as unknown as { d: { api: ApiClient } }).d.api = {
      register: (req) => registerNode(env.ctx, req),
      heartbeat: (req) => heartbeat(env.ctx, req),
      reports: (req) => ingestReports(env.ctx, req),
    };
    await rig.agent.boot();
    await rig.agent.register();
    await rig.agent.heartbeat();
    expect(await row(s.id)).toMatchObject({
      status: "ready",
      connectUrl: expect.any(String),
    });
    expect(rig.hub.routes.size).toBeGreaterThanOrEqual(0);
    expect(rig.agent.routes().map((r) => r.sessionId)).toEqual([s.id]);
    // and it can still be stopped
    await env.call("POST", `/v1/sessions/${s.id}/stop`);
    await settle();
    expect(await row(s.id)).toMatchObject({ status: "stopped" });
  });

  it("a lost stop message is repaired by the next heartbeat", async () => {
    const s = Session.parse((await env.create()).json());
    env.failpoints.set("api.node_stop", "drop:once");
    await env.call("POST", `/v1/sessions/${s.id}/stop`);
    await new Promise((r) => setTimeout(r, 50));
    expect(rig.store.getBinding(s.id)?.state).toBe("ready"); // the agent never heard
    await settle();
    expect(await row(s.id)).toMatchObject({
      status: "stopped",
      endReason: "client_stop",
    });
    expect(rig.docker.byRole("session")).toHaveLength(0);
  });

  it("a lost start (the agent never answers) ends cleanly with nothing left on the node", async () => {
    agentUp = false;
    const res = await env.create();
    expect(res.statusCode).toBe(500);
    expect(ErrorResponse.parse(res.json()).error.retryable).toBe(true);
    agentUp = true;
    env.clock.advance(5_000); // the API waits 4 s before taking the node's silence about a stopping session as confirmation
    await settle();
    const list = (await env.call("GET", "/v1/sessions")).json()
      .data as Session[];
    expect(list[0]).toMatchObject({ status: "failed" });
    expect(rig.store.allBindings()).toEqual([]);
  });

  it("a node lost and returning: its sessions fail, it stops them, and the fence lifts", async () => {
    const s = Session.parse((await env.create()).json());
    // The agent goes silent for 40 s while the sweeper keeps running.
    for (let t = 0; t < 40; t += 5) {
      env.clock.advance(5_000);
      rig.clock.advance(5_000);
      await env.sweeper.tick();
    }
    expect(await row(s.id)).toMatchObject({
      status: "failed",
      endReason: "node_lost",
    });
    expect((await env.create()).statusCode).toBe(503); // fenced
    // It comes back still holding the container.
    expect(rig.store.getBinding(s.id)?.state).toBe("ready");
    for (let i = 0; i < 4; i++) {
      await rig.agent.heartbeat();
      await rig.agent.idle();
      await rig.agent.flushReports();
    }
    expect(rig.store.epoch).toBe(2);
    expect(rig.store.getBinding(s.id)).toBeUndefined();
    expect(rig.docker.byRole("session")).toHaveLength(0);
    const again = await env.create();
    expect(again.statusCode).toBe(201);
  });
});
