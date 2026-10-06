import { z } from "zod";
import { CountryCode, defaultTimezoneFor } from "./geo.js";
import { PlainText } from "./plain-text.js";
import {
  PROXY_PROVIDERS,
  providerAdapter,
  type ExitRequest,
  type ProxyProvider,
} from "./proxy-providers.js";

/**
 * Upstream proxies (`docs/lld/upstream-proxy.md`). A session's traffic leaves through the
 * caller's own proxy, chained by the egress gateway (HLD 8.6, 8.12): HTTP (`http://`), HTTP
 * over TLS to the proxy (`https://`), or SOCKS5 (`socks5://`). The proxy always resolves the
 * destination. An optional provider adapter turns a provider-neutral exit request (country,
 * region, city, sticky session) into that provider's credential conventions. The password is
 * write-only: it reaches the node once, in the start request, and is never stored by the
 * control plane or returned.
 */

export const PROXY_LIMITS = {
  serverMaxLength: 300,
  usernameMaxLength: 255,
  passwordMaxLength: 255,
  /** RFC 1929: the username and password are each at most 255 bytes. */
  socksCredentialMaxBytes: 255,
} as const;

/** The schemes a proxy may use. `https` is TLS from the egress gateway to the proxy. */
export const PROXY_SCHEMES = ["http", "https", "socks5"] as const;
export type ProxyScheme = (typeof PROXY_SCHEMES)[number];

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

const SERVER = /^(https?|socks5):\/\/([^:/?#@[\]\s]+):([1-9][0-9]{0,4})\/?$/i;

/**
 * `scheme://host:port`, with an optional trailing slash and no credentials, path, query or
 * fragment. The scheme is `http`, `https` or `socks5`; the port must be explicit, at most
 * 65535 and not a bad port. Null if invalid.
 */
export function parseProxyServer(
  server: string,
): { scheme: ProxyScheme; host: string; port: number } | null {
  const m = SERVER.exec(server);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase() as ProxyScheme;
  const host = parseProxyHost(m[2]!);
  const port = Number(m[3]);
  if (!host || port > 65535 || PROXY_BLOCKED_PORTS.has(port)) return null;
  return { scheme, host, port };
}

/** The canonical spelling of a proxy server, as stored and returned. */
export function proxyServerUrl(
  scheme: ProxyScheme,
  host: string,
  port: number,
): string {
  return `${scheme}://${host}:${port}`;
}

export const ProxyServer = z
  .string()
  .max(PROXY_LIMITS.serverMaxLength)
  .superRefine((s, ctx) => {
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase();
    if (scheme === "socks5h" || scheme === "socks")
      ctx.addIssue({
        code: "custom",
        message:
          "use socks5://: the proxy always resolves hostnames, as socks5h:// would",
      });
    else if (scheme && !(PROXY_SCHEMES as readonly string[]).includes(scheme))
      ctx.addIssue({
        code: "custom",
        message: "only http://, https:// and socks5:// proxies are supported",
      });
    else if (!parseProxyServer(s))
      ctx.addIssue({
        code: "custom",
        message:
          "must be scheme://host:port (http, https or socks5): a hostname or IPv4 address and an explicit port that browsers allow, with no credentials, path or query",
      });
  })
  .describe(
    "The proxy, as `http://host:port`, `https://host:port` (TLS to the proxy) or `socks5://host:port`.",
  );

export const ProxyUsername = PlainText(
  1,
  PROXY_LIMITS.usernameMaxLength,
).refine(
  (u) => !u.includes(":"),
  "must not contain ':' (HTTP Basic authentication)",
);
export const ProxyPassword = PlainText(1, PROXY_LIMITS.passwordMaxLength);

export const ProxyProviderName = z
  .enum(PROXY_PROVIDERS)
  .describe(
    "How to ask the proxy for `country`, `region`, `city` and `sticky`. `generic` (the default) sends the username unchanged.",
  );

/** A provider's region or city name: letters, digits, spaces, `_`, `-` and `.`. */
const PlaceName = PlainText(1, 64).refine(
  (v) => /^[\p{L}\p{N}][\p{L}\p{N} _.'-]*$/u.test(v),
  "must be letters, digits, spaces, '_', '-', '.' or an apostrophe",
);

/** A sticky-session id: letters and digits. Providers bound it further. */
const StickyId = z
  .string()
  .regex(/^[A-Za-z0-9]{1,32}$/, "must be 1-32 letters and digits");

/** The exit fields, shared by the stored view and the create request. */
const exitFields = {
  provider: ProxyProviderName.optional(),
  country: CountryCode.optional().describe(
    "Exit country (ISO 3166-1 alpha-2). With a provider adapter, the proxy is asked for it; with `generic`, it only says where your proxy exits, and sets the default `timezone`.",
  ),
  region: PlaceName.optional().describe(
    "Exit region or state, in the provider's spelling (e.g. `california`). Needs `country` and a provider adapter that supports it.",
  ),
  city: PlaceName.optional().describe(
    "Exit city, in the provider's spelling (e.g. `new york`). Needs `country` and a provider adapter.",
  ),
  sticky: StickyId.optional().describe(
    "Keep the same exit address for requests carrying this id (a sticky session). Needs a provider adapter.",
  ),
  stickyMinutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .describe(
      "How long a sticky exit is kept, where the provider lets you choose. Needs `sticky`.",
    ),
};

/** The session's proxy as stored and returned: never a password. */
export const SessionProxy = z
  .strictObject({
    server: ProxyServer,
    username: ProxyUsername.optional(),
    ...exitFields,
  })
  .meta({
    id: "SessionProxy",
    description:
      "The session's upstream proxy. The username is the one given, before any provider adapter; the password is never returned.",
  });
export type SessionProxy = z.infer<typeof SessionProxy>;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/** As sent on create. */
export const ProxyConfig = z
  .strictObject({
    server: ProxyServer,
    username: ProxyUsername.optional().describe(
      "For authentication to the proxy (HTTP Basic, or SOCKS5 username and password).",
    ),
    password: ProxyPassword.optional().meta({
      writeOnly: true,
      description: "Write-only: never stored by the API or returned.",
    }),
    ...exitFields,
  })
  .superRefine((p, ctx) => {
    const issue = (path: string, message: string): void =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (p.password !== undefined && p.username === undefined)
      issue("password", "password requires username");
    const scheme = parseProxyServer(p.server)?.scheme;
    if (scheme === "socks5") {
      // RFC 1929 has no username-only form.
      if (p.username !== undefined && p.password === undefined)
        issue("password", "a socks5:// proxy with a username needs a password");
    }
    if ((p.region !== undefined || p.city !== undefined) && !p.country)
      issue("country", "region and city need country");
    if (p.stickyMinutes !== undefined && p.sticky === undefined)
      issue("stickyMinutes", "stickyMinutes needs sticky");
    const adapter = providerAdapter(p.provider);
    if (!adapter) {
      for (const k of ["region", "city", "sticky"] as const)
        if (p[k] !== undefined)
          issue(k, `${k} needs a provider adapter (set provider)`);
    } else {
      for (const i of adapter.check(p)) issue(i.path, i.message);
    }
    // What the proxy will actually receive must itself be valid.
    if (ctx.issues.length === 0) {
      const sent = applyProvider(p);
      if (sent.username !== undefined) {
        const u = ProxyUsername.safeParse(sent.username);
        if (!u.success)
          issue(
            "username",
            `the username with the exit request added ${u.error.issues[0]?.message ?? "is invalid"}`,
          );
      }
      if (sent.password !== undefined) {
        const pw = ProxyPassword.safeParse(sent.password);
        if (!pw.success)
          issue(
            "password",
            `the password with the exit request added ${pw.error.issues[0]?.message ?? "is invalid"}`,
          );
      }
      if (scheme === "socks5")
        for (const k of ["username", "password"] as const) {
          const v = sent[k];
          if (
            v !== undefined &&
            utf8Bytes(v) > PROXY_LIMITS.socksCredentialMaxBytes
          )
            issue(k, `must be at most 255 bytes for a socks5:// proxy`);
        }
    }
  })
  .meta({
    id: "ProxyConfig",
    description:
      "Send this session's traffic through your own proxy. The proxy resolves hostnames.",
  });
export type ProxyConfig = z.infer<typeof ProxyConfig>;

/** The credentials the proxy receives: the provider adapter applied, or unchanged. */
function applyProvider(p: ProxyConfig): {
  username?: string;
  password?: string;
} {
  const adapter = providerAdapter(p.provider);
  const exit: ExitRequest = {
    ...(p.country !== undefined ? { country: p.country } : {}),
    ...(p.region !== undefined ? { region: p.region } : {}),
    ...(p.city !== undefined ? { city: p.city } : {}),
    ...(p.sticky !== undefined ? { sticky: p.sticky } : {}),
    ...(p.stickyMinutes !== undefined
      ? { stickyMinutes: p.stickyMinutes }
      : {}),
  };
  if (!adapter || p.username === undefined)
    return {
      ...(p.username !== undefined ? { username: p.username } : {}),
      ...(p.password !== undefined ? { password: p.password } : {}),
    };
  return adapter.apply(p.username, p.password, exit);
}

/**
 * Internal (C4, C7): what the egress gateway connects to and authenticates with. `scheme` is
 * absent for `http`, so a node or gateway from before TLS and SOCKS5 still accepts an HTTP
 * proxy and refuses (strict schema) anything it cannot chain (T-47).
 */
export const UpstreamProxy = z.strictObject({
  scheme: z.enum(["https", "socks5"]).optional(),
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

/**
 * Split a validated create-time proxy into what is stored and what the node needs. The
 * stored view keeps the username as given and the exit request; the upstream carries what
 * the proxy must receive, the provider adapter applied.
 */
export function splitProxy(p: ProxyConfig): {
  stored: SessionProxy;
  upstream: UpstreamProxy;
} {
  const parsed = parseProxyServer(p.server);
  if (!parsed) throw new Error("splitProxy: server was not validated");
  const sent = applyProvider(p);
  const stored: SessionProxy = {
    server: proxyServerUrl(parsed.scheme, parsed.host, parsed.port),
    ...(p.username !== undefined ? { username: p.username } : {}),
    ...(p.provider !== undefined ? { provider: p.provider } : {}),
    ...(p.country !== undefined ? { country: p.country } : {}),
    ...(p.region !== undefined ? { region: p.region } : {}),
    ...(p.city !== undefined ? { city: p.city } : {}),
    ...(p.sticky !== undefined ? { sticky: p.sticky } : {}),
    ...(p.stickyMinutes !== undefined
      ? { stickyMinutes: p.stickyMinutes }
      : {}),
  };
  return {
    stored,
    upstream: {
      ...(parsed.scheme !== "http" ? { scheme: parsed.scheme } : {}),
      host: parsed.host,
      port: parsed.port,
      ...(sent.username !== undefined ? { username: sent.username } : {}),
      ...(sent.password !== undefined ? { password: sent.password } : {}),
    },
  };
}

/**
 * The session's time zone: the one asked for, else the default for the proxy's exit country
 * where there is a clear one (`COUNTRY_TIMEZONES`), else none.
 */
export function resolveTimezone(
  timezone: string | undefined,
  proxy: { country?: string | undefined } | undefined,
): string | undefined {
  return timezone ?? defaultTimezoneFor(proxy?.country);
}

export type { ProxyProvider };
