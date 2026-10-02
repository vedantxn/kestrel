import { Counter, Gauge, Registry } from "prom-client";

export function createEgressMetrics() {
  const registry = new Registry();
  const requests = new Counter({
    name: "kestrel_egress_requests_total",
    help: "Proxy requests by result: allowed, or the denial reason",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const open = new Gauge({
    name: "kestrel_egress_open_connections",
    help: "Open proxied connections",
    registers: [registry],
  });
  const bytes = new Counter({
    name: "kestrel_egress_bytes_total",
    help: "Bytes proxied, by direction relative to the browser",
    labelNames: ["direction"] as const,
    registers: [registry],
  });
  const policies = new Gauge({
    name: "kestrel_egress_policies",
    help: "Sessions with a policy",
    registers: [registry],
  });
  return { registry, requests, open, bytes, policies };
}
export type EgressMetrics = ReturnType<typeof createEgressMetrics>;
