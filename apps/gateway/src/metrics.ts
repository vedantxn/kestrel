import { Counter, Gauge, Registry } from "prom-client";

/** T15: `/metrics` on the gateway's internal port (7201 for node a). */
export function createGatewayMetrics() {
  const registry = new Registry();
  const connections = new Counter({
    name: "kestrel_gateway_connections_total",
    help: "Connection attempts, by result",
    labelNames: ["result"] as const,
    registers: [registry],
  });
  const open = new Gauge({
    name: "kestrel_gateway_connections",
    help: "Open client connections",
    registers: [registry],
  });
  const closes = new Counter({
    name: "kestrel_gateway_closes_total",
    help: "Connections closed, by close code",
    labelNames: ["code"] as const,
    registers: [registry],
  });
  const bytes = new Counter({
    name: "kestrel_gateway_relayed_bytes_total",
    help: "Bytes relayed",
    labelNames: ["direction"] as const,
    registers: [registry],
  });
  const routes = new Gauge({
    name: "kestrel_gateway_routes",
    help: "Routes in the table",
    registers: [registry],
  });
  const buffered = new Gauge({
    name: "kestrel_gateway_buffered_bytes",
    help: "Bytes queued for sending across all connections",
    registers: [registry],
  });
  return { registry, connections, open, closes, bytes, routes, buffered };
}
export type GatewayMetrics = ReturnType<typeof createGatewayMetrics>;
