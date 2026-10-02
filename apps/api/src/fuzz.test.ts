import { idToUuid } from "@kestrel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { NON_TERMINAL } from "./lifecycle.js";
import { makeEnv, type Env } from "./test/harness.js";

/**
 * Random interleavings of everything the control plane does (creates under every start outcome,
 * stops, lost stop messages, heartbeats, sweeps, silences, node-initiated ends), then a quiet
 * period, then the invariants that must always hold. Seeded, so a failure replays.
 */
let env: Env;
afterEach(async () => env?.close());

const rng = (seed: number) => {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
};

const SEEDS = Array.from({ length: 12 }, (_, i) => 100 + i);

describe("random interleavings keep the invariants", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, async () => {
      const rand = rng(seed);
      env = await makeEnv({
        nodes: [
          { id: "a", slots: 3 },
          { id: "b", slots: 3 },
        ],
        nodeCallTimeoutMs: 100,
        maxConcurrentSessions: 50,
      });
      const ids: string[] = [];
      const modes = [
        "hot",
        "hot",
        "cold",
        "refuse",
        "fail",
        "timeout",
        "unreachable",
        "late",
      ] as const;
      const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
      const nodes = Object.values(env.nodes);
      const swallow = (e: unknown) => {
        if (!/failpoint|500/.test(String(e))) throw e;
      };

      for (let step = 0; step < 100; step++) {
        const batch: Promise<unknown>[] = [];
        for (let k = 0, n = 1 + Math.floor(rand() * 4); k < n; k++) {
          const op = rand();
          if (op < 0.3) {
            for (const nd of nodes) nd.startMode = pick(modes);
            batch.push(
              env
                .create({})
                .then(
                  (r) => void (r.statusCode === 201 && ids.push(r.json().id)),
                ),
            );
          } else if (op < 0.45 && ids.length) {
            batch.push(env.call("POST", `/v1/sessions/${pick(ids)}/stop`));
          } else if (op < 0.65) {
            if (rand() < 0.3) env.failpoints.set("api.node_stop", "drop:once");
            batch.push(pick(nodes).sync(env.internal).catch(swallow));
          } else if (op < 0.8) {
            env.clock.advance(Math.floor(rand() * 8000));
            batch.push(env.sweeper.tick());
          } else if (op < 0.9) {
            const nd = pick(nodes);
            const held = [...nd.held.keys()];
            if (held.length)
              nd.expire(
                pick(held),
                pick([
                  "idle_timeout",
                  "max_lifetime",
                  "oom",
                  "browser_crash",
                ] as const),
              );
          } else {
            const nd = pick(nodes);
            const held = [...nd.held.keys()];
            if (held.length)
              nd.report(pick(held), {
                type: "session.attached",
                data: { connections: 1 },
              });
          }
        }
        await Promise.all(batch.map((p) => p.catch(swallow)));
        for (const [id, nd] of Object.entries(env.nodes)) {
          const live = await env.db.session.count({
            where: { nodeId: id, status: { in: NON_TERMINAL } },
          });
          expect(
            live,
            `node ${id} oversubscribed at step ${step}`,
          ).toBeLessThanOrEqual(nd.slotsTotal);
        }
      }

      // Quiet: every fault stops and everything is healthy for a while.
      for (const nd of nodes) nd.startMode = "hot";
      env.failpoints.clear();
      for (let i = 0; i < 80; i++) {
        env.clock.advance(2000);
        for (const nd of nodes)
          await nd.sync(env.internal).catch(() => undefined);
        if (i % 3 === 0) await env.sweeper.tick();
      }

      const rows = await env.db.session.findMany({ include: { events: true } });
      const problems: string[] = [];
      for (const r of rows) {
        const terminal = ["stopped", "failed", "timed_out"].includes(r.status);
        const ended = r.events.filter((e) => e.type === "session.ended").length;
        if (terminal && ended !== 1)
          problems.push(`${r.id}: terminal with ${ended} ended events`);
        if (!terminal && ended > 0)
          problems.push(`${r.id}: ${r.status} but has an ended event`);
        const nd = env.nodes[r.nodeId!]!;
        const held = [...nd.held.keys()].some((k) => idToUuid(k) === r.id);
        if (!terminal && r.status === "stopping")
          problems.push(`${r.id}: stuck stopping`);
        if (!terminal && !held)
          problems.push(
            `${r.id}: ${r.status} but the node does not hold it (leaked slot)`,
          );
        if (terminal && held)
          problems.push(`${r.id}: terminal but the node still holds it`);
      }
      expect(problems).toEqual([]);
    });
  }
});
