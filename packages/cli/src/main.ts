import { writeFile } from "node:fs/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  ApiError,
  Kestrel,
  KestrelError,
  type CreateSessionRequest,
  type Session,
  type SessionEvent,
  type SessionStatus,
} from "@kestrel/sdk";

export interface Io {
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Aborted on Ctrl-C. */
  signal?: AbortSignal | undefined;
  /** For tests: a `fetch` the SDK uses instead of the network. */
  fetch?: typeof fetch | undefined;
}

export const USAGE = `Usage: kestrel <command> [options]

Commands:
  sessions create [--timeout ms] [--idle-timeout ms] [--viewport WxH] [--record]
                  [--allow host]... [--deny host]... [--wait-for-capacity ms]
                  [--proxy scheme://host:port [--proxy-username u]]
                                scheme is http, https (TLS to the proxy) or
                                socks5; the proxy's password is read from
                                $KESTREL_PROXY_PASSWORD, never from a flag
                  [--proxy-provider p] [--proxy-country CC] [--proxy-region r]
                  [--proxy-city c] [--proxy-sticky id] [--proxy-sticky-minutes n]
                                an exit from a residential provider: brightdata,
                                oxylabs, decodo or iproyal (default generic)
                  [--timezone Area/City]
                                the browser's time zone; defaults from
                                --proxy-country where it has one clear zone
                  [--solve-captchas]
                                send reCAPTCHA, hCaptcha and Turnstile to the
                                deployment's solver service (its page URL and
                                site key go to that third party)
  sessions list [--status s] [--limit n] [--cursor c]
  sessions get <id>
  sessions stop <id>
  logs <id> [--follow]          a session's events; --follow polls until it ends
  connect-url <id>              print the session's wss:// URL (it contains a token)
  live <id> [--control] [--ttl ms]
                                print a live-view page URL (it contains a token);
                                --control lets the viewer use mouse and keyboard
  screenshot <id> [-o file.png] save a PNG of the current page (default <id>.png)
  recording <id> [-o file.mp4]  save the session's video (default <id>.mp4);
                                the session must be created with --record

Options:
  --json             print the API's JSON (logs: one event per line)
  --api-key <key>    default: $KESTREL_API_KEY
  --url <url>        default: $KESTREL_URL, then http://localhost:8080
  -h, --help
`;

class UsageError extends Error {}

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<
  string,
  string | boolean | (string | boolean)[] | undefined
>;

const GLOBAL: Options = {
  json: { type: "boolean" },
  "api-key": { type: "string" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
};

interface Command {
  options: Options;
  /** The positional arguments it takes, by name, for the usage message. */
  args: string[];
  run(k: Kestrel, args: string[], v: Values, io: Io): Promise<number>;
}

const COMMANDS: Record<string, Command> = {
  "sessions create": {
    options: {
      timeout: { type: "string" },
      "idle-timeout": { type: "string" },
      viewport: { type: "string" },
      allow: { type: "string", multiple: true },
      deny: { type: "string", multiple: true },
      "wait-for-capacity": { type: "string" },
      record: { type: "boolean" },
      proxy: { type: "string" },
      "proxy-username": { type: "string" },
      "proxy-provider": { type: "string" },
      "proxy-country": { type: "string" },
      "proxy-region": { type: "string" },
      "proxy-city": { type: "string" },
      "proxy-sticky": { type: "string" },
      "proxy-sticky-minutes": { type: "string" },
      timezone: { type: "string" },
      "solve-captchas": { type: "boolean" },
    },
    args: [],
    async run(k, _args, v, io) {
      const req: CreateSessionRequest = {
        timeout: int(v, "timeout"),
        idleTimeout: int(v, "idle-timeout"),
        waitForCapacityMs: int(v, "wait-for-capacity"),
        recording: v.record === true ? true : undefined,
      };
      if (typeof v.viewport === "string") req.viewport = viewport(v.viewport);
      if (v.allow || v.deny)
        req.network = {
          allow: v.allow as string[] | undefined,
          deny: v.deny as string[] | undefined,
        };
      req.proxy = proxy(v, io);
      if (typeof v.timezone === "string") req.timezone = v.timezone;
      if (v["solve-captchas"] === true) req.captcha = { solve: true };
      const s = await k.sessions.create(req, { signal: io.signal });
      if (v.json) return json(io, s);
      io.stdout(details(s));
      io.stdout(`\nConnect with: kestrel connect-url ${s.id}\n`);
      return 0;
    },
  },

  "sessions list": {
    options: {
      status: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
    },
    args: [],
    async run(k, _args, v, io) {
      const page = await k.sessions.list(
        {
          status: v.status as SessionStatus | undefined,
          limit: int(v, "limit"),
          cursor: v.cursor as string | undefined,
        },
        { signal: io.signal },
      );
      if (v.json) return json(io, page);
      io.stdout(
        table([
          ["ID", "STATUS", "CREATED", "END REASON"],
          ...page.data.map((s) => [
            s.id,
            s.status,
            s.createdAt,
            s.endReason ?? "",
          ]),
        ]),
      );
      if (page.nextCursor)
        io.stdout(
          `\nMore: kestrel sessions list --cursor ${page.nextCursor}\n`,
        );
      return 0;
    },
  },

  "sessions get": {
    options: {},
    args: ["id"],
    async run(k, [id], v, io) {
      const s = await k.sessions.get(id!, { signal: io.signal });
      if (v.json) return json(io, s);
      io.stdout(details(s));
      return 0;
    },
  },

  "sessions stop": {
    options: {},
    args: ["id"],
    async run(k, [id], v, io) {
      const s = await k.sessions.stop(id!, { signal: io.signal });
      if (v.json) return json(io, s);
      io.stdout(`${s.id} ${s.status}\n`);
      return 0;
    },
  },

  logs: {
    options: { follow: { type: "boolean", short: "f" } },
    args: ["id"],
    async run(k, [id], v, io) {
      for await (const e of k.sessions.iterEvents(id!, {
        follow: v.follow === true,
        signal: io.signal,
      }))
        io.stdout(v.json ? `${JSON.stringify(e)}\n` : eventLine(e));
      return 0;
    },
  },

  "connect-url": {
    options: {},
    args: ["id"],
    async run(k, [id], _v, io) {
      const s = await k.sessions.get(id!, { signal: io.signal });
      if (!s.connectUrl) {
        io.stderr(
          `error: session ${s.id} is ${s.status} and cannot be connected to\n`,
        );
        return 1;
      }
      io.stdout(`${s.connectUrl}\n`);
      return 0;
    },
  },

  live: {
    options: { control: { type: "boolean" }, ttl: { type: "string" } },
    args: ["id"],
    async run(k, [id], v, io) {
      const t = await k.sessions.mintToken(
        id!,
        { scope: v.control ? "control" : "view", ttlMs: int(v, "ttl") },
        { signal: io.signal },
      );
      if (v.json) return json(io, t);
      io.stdout(`${t.url}\n`);
      return 0;
    },
  },

  screenshot: {
    options: { output: { type: "string", short: "o" } },
    args: ["id"],
    async run(k, [id], v, io) {
      const path = (v.output as string | undefined) ?? `${id}.png`;
      const r = await k.sessions.computer(
        id!,
        { action: "screenshot" },
        { signal: io.signal },
      );
      if (!r.screenshot)
        throw new KestrelError("the API answered without a screenshot");
      await writeFile(path, Buffer.from(r.screenshot, "base64"));
      if (v.json)
        return json(io, { path, width: r.width, height: r.height, url: r.url });
      io.stdout(`${path}  ${r.width}x${r.height}  ${r.url}\n`);
      return 0;
    },
  },

  recording: {
    options: { output: { type: "string", short: "o" } },
    args: ["id"],
    async run(k, [id], v, io) {
      const path = (v.output as string | undefined) ?? `${id}.mp4`;
      const bytes = await k.sessions.saveRecording(id!, path, {
        signal: io.signal,
      });
      if (v.json) return json(io, { path, bytes });
      io.stdout(`${path}  ${bytes} bytes\n`);
      return 0;
    },
  },
};

/** Run the CLI and return its exit code: 0 ok, 1 the API or network failed, 2 bad usage. */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (io.signal?.aborted) return 130;
    if (e instanceof UsageError || isParseArgsError(e)) {
      io.stderr(`error: ${(e as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof ApiError) {
      io.stderr(
        `error: ${e.message}${e.requestId ? ` (request ${e.requestId})` : ""}\n`,
      );
      return 1;
    }
    if (e instanceof KestrelError) {
      io.stderr(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  const words = argv[0] === "sessions" ? 2 : 1;
  const name = argv.slice(0, words).join(" ");
  const cmd = COMMANDS[name];
  if (!cmd) throw new UsageError(`unknown command: ${name}`);

  const { values, positionals } = parseArgs({
    args: argv.slice(words),
    options: { ...GLOBAL, ...cmd.options },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (positionals.length !== cmd.args.length)
    throw new UsageError(
      cmd.args.length
        ? `${name} takes ${cmd.args.map((a) => `<${a}>`).join(" ")}`
        : `${name} takes no arguments`,
    );

  const kestrel = new Kestrel({
    apiKey: (values["api-key"] as string | undefined) ?? io.env.KESTREL_API_KEY,
    baseUrl: (values.url as string | undefined) ?? io.env.KESTREL_URL,
    fetch: io.fetch,
  });
  return cmd.run(kestrel, positionals, values, io);
}

function isParseArgsError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

function int(v: Values, flag: string): number | undefined {
  const raw = v[flag];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw))
    throw new UsageError(
      `--${flag} must be a whole number, got ${String(raw)}`,
    );
  return Number(raw);
}

function viewport(raw: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(raw);
  if (!m)
    throw new UsageError(`--viewport must look like 1280x720, got ${raw}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function json(io: Io, value: unknown): number {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

/** Columns padded to their widest cell, two spaces apart. */
export function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  return rows
    .map((r) =>
      r
        .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
    .concat("\n");
}

/**
 * `--proxy` and `--proxy-username`. The password comes from the environment only: a flag would
 * leave it in shell history and in the process list.
 */
function proxy(v: Values, io: Io): CreateSessionRequest["proxy"] {
  const password = io.env.KESTREL_PROXY_PASSWORD || undefined;
  const username =
    typeof v["proxy-username"] === "string" ? v["proxy-username"] : undefined;
  const exitFlags = [
    "proxy-provider",
    "proxy-country",
    "proxy-region",
    "proxy-city",
    "proxy-sticky",
    "proxy-sticky-minutes",
  ] as const;
  if (typeof v.proxy !== "string") {
    if (username)
      throw new UsageError("--proxy-username needs --proxy scheme://host:port");
    const stray = exitFlags.find((f) => v[f] !== undefined);
    if (stray)
      throw new UsageError(`--${stray} needs --proxy scheme://host:port`);
    return undefined;
  }
  if (password && !username)
    throw new UsageError(
      "KESTREL_PROXY_PASSWORD is set: pass --proxy-username as well",
    );
  const str = (k: (typeof exitFlags)[number]): string | undefined =>
    typeof v[k] === "string" ? (v[k] as string) : undefined;
  const provider = str("proxy-provider");
  return {
    server: v.proxy,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(provider
      ? {
          provider: provider as NonNullable<
            CreateSessionRequest["proxy"]
          >["provider"],
        }
      : {}),
    ...(str("proxy-country") ? { country: str("proxy-country") } : {}),
    ...(str("proxy-region") ? { region: str("proxy-region") } : {}),
    ...(str("proxy-city") ? { city: str("proxy-city") } : {}),
    ...(str("proxy-sticky") ? { sticky: str("proxy-sticky") } : {}),
    ...(v["proxy-sticky-minutes"] !== undefined
      ? { stickyMinutes: int(v, "proxy-sticky-minutes") }
      : {}),
  };
}

/** Where the proxy was asked to exit: `DE, munich, sticky abc123`. */
function exitOf(p: NonNullable<Session["options"]["proxy"]>): string {
  const parts = [p.country, p.region, p.city].filter(Boolean) as string[];
  if (p.sticky)
    parts.push(
      `sticky ${p.sticky}${p.stickyMinutes ? ` for ${p.stickyMinutes} min` : ""}`,
    );
  const via =
    p.provider && p.provider !== "generic" ? ` via ${p.provider}` : "";
  return parts.length || via ? `; exit ${parts.join(", ") || "any"}${via}` : "";
}

/**
 * One session as `key  value` lines. `connectUrl` is left out on purpose: it carries a
 * bearer token, and terminal output ends up in screenshots and shared logs.
 */
function details(s: Session): string {
  const rows: [string, string][] = [
    ["id", s.id],
    ["status", s.status],
    ["created", s.createdAt],
    ["ready", s.readyAt ?? "-"],
    ["ended", s.endedAt ?? "-"],
    ["end reason", s.endReason ?? "-"],
    ["node", s.nodeId ?? "-"],
    ["start path", s.startPath ?? "-"],
    ["viewport", `${s.viewport.width}x${s.viewport.height}`],
    ["timeout", `${s.options.timeout} ms`],
    ["idle timeout", `${s.options.idleTimeout} ms`],
    ["recording", s.options.recording ? "yes" : "no"],
    [
      "proxy",
      s.options.proxy
        ? s.options.proxy.server +
          (s.options.proxy.username
            ? ` (as ${s.options.proxy.username})`
            : "") +
          exitOf(s.options.proxy)
        : "-",
    ],
    ["timezone", s.options.timezone ?? "-"],
    ["solve captchas", s.options.captcha?.solve ? "yes" : "no"],
    ["browser seconds", String(s.usage.browserSeconds)],
    [
      "egress bytes",
      `${s.usage.egressBytesUp} up, ${s.usage.egressBytesDown} down`,
    ],
    [
      "captcha",
      s.captcha
        ? `${s.captcha.providers.join(", ")} (since ${s.captcha.since})` +
          (s.captcha.solve
            ? `; ${s.captcha.solve.provider} ${s.captcha.solve.status}` +
              (s.captcha.solve.reason ? ` (${s.captcha.solve.reason})` : "")
            : "")
        : "-",
    ],
  ];
  const meta = Object.entries(s.options.metadata);
  if (meta.length)
    rows.push(["metadata", meta.map(([k, v]) => `${k}=${v}`).join(" ")]);
  return table(rows);
}

function eventLine(e: SessionEvent): string {
  const data = Object.entries(e.data as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${e.at}  ${e.type.padEnd(18)}  ${data}`.trimEnd() + "\n";
}
