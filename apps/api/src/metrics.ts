import { Counter, Gauge, Histogram, Registry } from "prom-client";

/** T15: `/metrics` on the internal listener. H7's measurements come from these. */
export function createMetrics() {
  const registry = new Registry();
  const create = new Histogram({
    name: "kestrel_session_create_seconds",
    help: "Time to create a session, request to ready, by start path",
    labelNames: ["path"] as const,
    buckets: [0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });
  const created = new Counter({
    name: "kestrel_sessions_created_total",
    help: "Sessions created, by outcome",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });
  const ended = new Counter({
    name: "kestrel_sessions_ended_total",
    help: "Sessions that reached a terminal status, by status and reason",
    labelNames: ["status", "reason"] as const,
    registers: [registry],
  });
  const sweeper = new Counter({
    name: "kestrel_sweeper_actions_total",
    help: "Sweeper actions",
    labelNames: ["action"] as const,
    registers: [registry],
  });
  const heartbeats = new Counter({
    name: "kestrel_node_heartbeats_total",
    help: "Heartbeats received, by node",
    labelNames: ["node"] as const,
    registers: [registry],
  });
  const sessions = new Gauge({
    name: "kestrel_sessions",
    help: "Sessions by status (refreshed at scrape)",
    labelNames: ["status"] as const,
    registers: [registry],
  });
  return { registry, create, created, ended, sweeper, heartbeats, sessions };
}
export type Metrics = ReturnType<typeof createMetrics>;
