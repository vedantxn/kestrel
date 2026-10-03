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
  sessions create [--timeout ms] [--idle-timeout ms] [--viewport WxH]
                  [--allow host]... [--deny host]... [--wait-for-capacity ms]
  sessions list [--status s] [--limit n] [--cursor c]
  sessions get <id>
  sessions stop <id>
  logs <id> [--follow]          a session's events; --follow polls until it ends
  connect-url <id>              print the session's wss:// URL (it contains a token)

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
    },
    args: [],
    async run(k, _args, v, io) {
      const req: CreateSessionRequest = {
        timeout: int(v, "timeout"),
        idleTimeout: int(v, "idle-timeout"),
        waitForCapacityMs: int(v, "wait-for-capacity"),
      };
      if (typeof v.viewport === "string") req.viewport = viewport(v.viewport);
      if (v.allow || v.deny)
        req.network = {
          allow: v.allow as string[] | undefined,
          deny: v.deny as string[] | undefined,
        };
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
    ["browser seconds", String(s.usage.browserSeconds)],
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
