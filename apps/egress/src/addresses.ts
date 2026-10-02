import { BlockList, isIP } from "node:net";

/**
 * N7. The server-side request forgery defence. A destination is allowed only if it is an ordinary
 * public unicast IPv4 address. Everything else is refused: private, loopback, "this network",
 * link-local (which holds the cloud metadata services), carrier-grade NAT, benchmarking,
 * documentation, reserved, multicast and broadcast, and IPv6 destinations of any kind (the
 * session network has no IPv6, and tunnelled forms such as 6to4, NAT64 and IPv4-mapped addresses
 * could otherwise reach blocked IPv4 space). Ported from agentuse-qa's `ssrf.ts`.
 */
const BLOCKED_V4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT (includes Alibaba's metadata address)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link local: AWS, GCP, Azure metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, "ipv4");
}

/** True if `address` may be connected to. Only public unicast IPv4 passes. */
export function isPublicUnicastIPv4(address: string): boolean {
  return isIP(address) === 4 && !BLOCKED_V4.check(address, "ipv4");
}

export type Target =
  | { kind: "ip"; ip: string }
  | { kind: "name"; name: string }
  | { kind: "invalid"; why: string };

/**
 * Classify the host part of a CONNECT target or a proxied URL.
 *
 * An address can be written many ways that other software accepts: decimal (2130706433), hex
 * (0x7f000001), octal (0177.0.0.1), short forms (127.1), IPv6 brackets, IPv4-mapped IPv6. The
 * WHATWG URL parser, which is what browsers use, normalises all of these to dotted-quad or to an
 * IPv6 literal, so we ask it, and then classify what it produced. Anything it does not call a
 * valid host is invalid.
 */
export function parseHost(raw: string): Target {
  const host = raw.trim();
  if (host === "") return { kind: "invalid", why: "empty host" };
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\s\u0000-\u001f\u007f@/\\?#%]/.test(host))
    return { kind: "invalid", why: "forbidden character in host" };
  let url: URL;
  try {
    url = new URL(`http://${host}/`);
  } catch {
    return { kind: "invalid", why: "not a valid host" };
  }
  if (url.username || url.password || url.port !== "")
    return { kind: "invalid", why: "host carries more than a host" };
  const h = url.hostname;
  if (h.startsWith("[")) return { kind: "ip", ip: h.slice(1, -1) }; // IPv6: always refused later
  if (isIP(h) === 4) return { kind: "ip", ip: h };
  // The URL parser leaves an all-numeric last label alone only if it is not a valid IPv4 form; refuse those.
  const labels = h.replace(/\.$/, "").split(".");
  if (/^(0x[0-9a-f]*|\d+)$/i.test(labels[labels.length - 1] ?? ""))
    return { kind: "invalid", why: "ambiguous numeric host" };
  if (
    !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/.test(
      h,
    ) ||
    h.length > 253
  ) {
    return { kind: "invalid", why: "not a hostname" };
  }
  return { kind: "name", name: h.replace(/\.$/, "") };
}

/** A parsed IP target is allowed only if it is public unicast IPv4. */
export function ipAllowed(ip: string): boolean {
  return isPublicUnicastIPv4(ip);
}
