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
  const share = new Gauge({
    name: "kestrel_gateway_session_share_bytes",
    help: "Each session's share of the buffer budget (threat model G-03)",
    registers: [registry],
  });
  const largestSession = new Gauge({
    name: "kestrel_gateway_largest_session_buffered_bytes",
    help: "Bytes queued for sending by the session holding the most",
    registers: [registry],
  });
  const overShare = new Gauge({
    name: "kestrel_gateway_sessions_over_share",
    help: "Sessions holding more than their share of the buffer budget",
    registers: [registry],
  });
  const pauses = new Counter({
    name: "kestrel_gateway_pauses_total",
    help: "Times a side stopped being read: buffer (its peer's send buffer is full) or share (its session is over its share)",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  const budgetCloses = new Counter({
    name: "kestrel_gateway_budget_closes_total",
    help: "Connections closed (4008) because the buffer budget was full: over_share (the arriving session was over its share), evicted (closed to make room for a session within its share), global (nothing could give way)",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  return {
    registry,
    connections,
    open,
    closes,
    bytes,
    routes,
    buffered,
    share,
    largestSession,
    overShare,
    pauses,
    budgetCloses,
  };
}
export type GatewayMetrics = ReturnType<typeof createGatewayMetrics>;
