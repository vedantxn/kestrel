import { z } from "zod";
import { ProjectId, SessionId } from "./ids.js";
import { SessionProof } from "./tokens.js";

/**
 * C6 (drafted; the gateway plan finalises it). The node-local routing protocol between a node
 * agent and each gateway on that node (G12): newline-delimited JSON over a Unix socket at
 * `/run/kestrel/<node>/agent.sock`, mode 0600.
 *
 * The gateway connects. The agent sends the full route table, then changes. The gateway reports
 * its current attachments on connecting and whenever they change, as a full snapshot, so a lost
 * or repeated message does no harm. If the connection closes, the agent treats that gateway's
 * attachments as gone, so a gateway crash starts the idle timers instead of leaving them
 * held forever.
 *
 * Routes carry the session proof (a secret); the socket's permissions are what protect it.
 */
export const AGENT_GATEWAY_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;

export const Route = z.object({
  sessionId: SessionId,
  projectId: ProjectId,
  /** The container's address on the node's session network. */
  address: z.ipv4(),
  port: z.number().int().min(1).max(65535),
  proof: SessionProof,
  /** Epoch seconds. After this the gateway refuses to route, whether or not it hears from the agent. */
  notAfter: z.number().int(),
});
export type Route = z.infer<typeof Route>;

export const Attachment = z.object({
  sessionId: SessionId,
  connections: z.number().int().positive(),
});
export type Attachment = z.infer<typeof Attachment>;

/** Gateway -> agent. */
export const GatewayMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(AGENT_GATEWAY_PROTOCOL_VERSION),
    /** Distinguishes two gateways that overlap during a deploy. */
    gatewayId: z.string().min(1).max(64),
    attachments: z.array(Attachment),
  }),
  z.object({
    type: z.literal("attachments"),
    attachments: z.array(Attachment),
  }),
]);
export type GatewayMessage = z.infer<typeof GatewayMessage>;

/** Agent -> gateway. */
export const AgentMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("routes"), routes: z.array(Route) }),
  z.object({ type: z.literal("route.put"), route: Route }),
  z.object({ type: z.literal("route.remove"), sessionId: SessionId }),
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

/** One message per line. */
export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** Parse one line against a schema. Returns null for a line that is not a valid message. */
export function decodeLine<T extends z.ZodType>(
  schema: T,
  line: string,
): z.infer<T> | null {
  if (line.length > MAX_FRAME_BYTES) return null;
  try {
    const r = schema.safeParse(JSON.parse(line));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
