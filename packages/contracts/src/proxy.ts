import { z } from "zod";
import { PlainText } from "./plain-text.js";

/**
 * Upstream proxies (`docs/lld/upstream-proxy.md`). A session's traffic leaves through the
 * caller's own HTTP proxy, chained by the egress gateway (HLD 8.6, 8.12). Bring your own,
 * `http://` only. The password is write-only: it reaches the node once, in the start
 * request, and is never stored by the control plane or returned.
 */

export const PROXY_LIMITS = {
  serverMaxLength: 300,
  usernameMaxLength: 255,
  passwordMaxLength: 255,
} as const;

/**
 * The Fetch standard's "bad ports", refused for a proxy (T-48): the gateway streams a plain
 * HTTP request to the proxy before it knows the far end speaks HTTP, so a proxy "on" a mail,
 * chat or SSH port would make the gateway a cross-protocol relay.
 */
export const PROXY_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);

/**
 * A proxy host, lowercased: a dotted-quad IPv4 address, or a hostname whose last label is
 * not all digits (so `127.1`, `0x7f.1` and other spellings a resolver might read as an
 * address are refused rather than guessed at). No IPv6, no trailing dot. Null if invalid.
 */
export function parseProxyHost(host: string): string | null {
  const h = host.toLowerCase();
  if (h.length < 1 || h.length > 253) return null;
  if (/^[0-9.]+$/.test(h)) return IPV4.test(h) ? h : null;
  const labels = h.split(".");
  if (!labels.every((l) => LABEL.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return h;
}

const SERVER = /^http:\/\/([^:/?#@[\]\s]+):([1-9][0-9]{0,4})\/?$/i;

/**
 * `http://host:port`, with an optional trailing slash and no credentials, path, query or
 * fragment. The port must be explicit, at most 65535 and not a bad port. Null if invalid.
 */
export function parseProxyServer(
  server: string,
): { host: string; port: number } | null {
  const m = SERVER.exec(server);
  if (!m) return null;
  const host = parseProxyHost(m[1]!);
  const port = Number(m[2]);
  if (!host || port > 65535 || PROXY_BLOCKED_PORTS.has(port)) return null;
  return { host, port };
}

/** The canonical spelling of a proxy server, as stored and returned. */
export function proxyServerUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export const ProxyServer = z
  .string()
  .max(PROXY_LIMITS.serverMaxLength)
  .superRefine((s, ctx) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^http:\/\//i.test(s))
      ctx.addIssue({
        code: "custom",
        message: "only http:// proxies are supported",
      });
    else if (!parseProxyServer(s))
      ctx.addIssue({
        code: "custom",
        message:
          "must be http://host:port: a hostname or IPv4 address and an explicit port that browsers allow, with no credentials, path or query",
      });
  })
  .describe("The proxy, as `http://host:port`.");

export const ProxyUsername = PlainText(
  1,
  PROXY_LIMITS.usernameMaxLength,
).refine(
  (u) => !u.includes(":"),
  "must not contain ':' (HTTP Basic authentication)",
);
export const ProxyPassword = PlainText(1, PROXY_LIMITS.passwordMaxLength);

/** The session's proxy as stored and returned: never a password. */
export const SessionProxy = z
  .strictObject({
    server: ProxyServer,
    username: ProxyUsername.optional(),
  })
  .meta({
    id: "SessionProxy",
    description:
      "The session's upstream proxy. The password is never returned.",
  });
export type SessionProxy = z.infer<typeof SessionProxy>;

/** As sent on create. */
export const ProxyConfig = z
  .strictObject({
    server: ProxyServer,
    username: ProxyUsername.optional().describe(
      "For HTTP Basic authentication to the proxy.",
    ),
    password: ProxyPassword.optional().meta({
      writeOnly: true,
      description: "Write-only: never stored by the API or returned.",
    }),
  })
  .refine((p) => p.password === undefined || p.username !== undefined, {
    message: "password requires username",
    path: ["password"],
  })
  .meta({
    id: "ProxyConfig",
    description:
      "Send this session's traffic through your own HTTP proxy. The proxy resolves hostnames.",
  });
export type ProxyConfig = z.infer<typeof ProxyConfig>;

/** Internal (C4, C7): what the egress gateway connects to and authenticates with. */
export const UpstreamProxy = z.strictObject({
  host: z
    .string()
    .refine((h) => parseProxyHost(h) === h, "not a lowercase proxy host"),
  port: z.number().int().min(1).max(65535),
  username: ProxyUsername.optional(),
  password: ProxyPassword.optional(),
});
export type UpstreamProxy = z.infer<typeof UpstreamProxy>;

/** An upstream as listed by the egress gateway: never a password. */
export const UpstreamProxyView = UpstreamProxy.omit({ password: true });
export type UpstreamProxyView = z.infer<typeof UpstreamProxyView>;

/** Split a validated create-time proxy into what is stored and what the node needs. */
export function splitProxy(p: ProxyConfig): {
  stored: SessionProxy;
  upstream: UpstreamProxy;
} {
  const parsed = parseProxyServer(p.server);
  if (!parsed) throw new Error("splitProxy: server was not validated");
  const user = p.username !== undefined ? { username: p.username } : {};
  return {
    stored: { server: proxyServerUrl(parsed.host, parsed.port), ...user },
    upstream: {
      host: parsed.host,
      port: parsed.port,
      ...user,
      ...(p.password !== undefined ? { password: p.password } : {}),
    },
  };
}
