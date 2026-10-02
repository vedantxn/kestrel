import { z } from "zod";

/**
 * A hostname pattern in a session's allow or deny list (N10): an exact hostname, or `*.`
 * followed by a hostname, which matches that hostname's subdomains at any depth but not
 * the hostname itself. Case-insensitive. The API validates with this schema and the egress
 * gateway decides with `matchesHostPattern`, so both agree on what a pattern means.
 */
const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^(\\*\\.)?(${LABEL}\\.)*${LABEL}$`);

export const HostPattern = z
  .string()
  .transform((s) => s.toLowerCase())
  .pipe(
    z
      .string()
      .max(253)
      .regex(HOST_RE, "a hostname, or *. followed by a hostname")
      .refine(
        (s) => !/^[0-9.]+$/.test(s.replace(/^\*\./, "")),
        "IP addresses are not hostnames",
      ),
  );
export type HostPattern = z.infer<typeof HostPattern>;

export function matchesHostPattern(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase().replace(/\.$/, "");
  if (p.startsWith("*."))
    return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/**
 * Text that came from a browser (a hostname it tried to reach, for instance) is hostile input. Before it
 * is stored or logged, control characters, including NUL, which Postgres cannot hold, are replaced.
 */
export function sanitizeText(value: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return value.replace(/[\u0000-\u001f\u007f]/g, "\ufffd");
}

/** `sanitizeText` over every string in a JSON-like value. */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [sanitizeText(k), sanitizeDeep(v)]),
    ) as T;
  }
  return value;
}
