/**
 * K13. Named points in the API and the node agent where a test can make the process fail or
 * stall at an exact moment. Switched on only by the `KESTREL_FAILPOINTS` environment variable
 * (or, in-process, by `set`), never by a request.
 *
 *   KESTREL_FAILPOINTS="api.create.after_reserve=exit,api.node_stop=drop:once"
 *
 * Actions: `exit` (the process dies at once, like SIGKILL), `throw`, `stall:<ms>`, `drop`
 * (the caller skips the step it was about to do). A `:once` suffix fires one time.
 *
 * Threat model G-16: failpoints are never invisible. The process logs a warning at startup,
 * the internal `/healthz` lists the active ones, and the invariant checker flags any outside
 * a test run.
 */
export const FAILPOINT_NAMES = [
  // API
  "api.create.after_reserve", // the slot is reserved, the node not yet called
  "api.create.before_ready", // the node answered, the session not yet marked ready
  "api.node_start", // use `drop` to lose the start message
  "api.node_stop", // use `drop` to lose the stop message
  "api.sweeper.tick",
  // Node agent: a process that dies at one of these leaves exactly the state a crash there would.
  "node.start.after_binding", // the binding is written, no container yet
  "node.start.after_acquire", // a container is bound, no policy yet
  "node.start.after_policy", // the egress policy is set, the container not yet configured
  "node.start.after_configure", // configured, no route yet
  "node.start.before_ready", // routed, not yet marked ready
  "node.stop.after_route_removed",
  "node.stop.after_policy_cleared",
  "node.stop.after_container_removed", // before the binding is deleted and the report queued
] as const;

export type FailpointName = (typeof FAILPOINT_NAMES)[number] | (string & {});

type Action =
  | { kind: "exit" }
  | { kind: "throw" }
  | { kind: "stall"; ms: number }
  | { kind: "drop" };

interface Armed {
  action: Action;
  once: boolean;
  text: string;
}

export class FailpointError extends Error {
  constructor(readonly point: string) {
    super(`failpoint ${point} fired`);
  }
}

function parseAction(text: string): Armed {
  const [head = "", ...rest] = text.split(":");
  const once = rest[rest.length - 1] === "once";
  const args = once ? rest.slice(0, -1) : rest;
  switch (head) {
    case "exit":
    case "throw":
    case "drop":
      return { action: { kind: head }, once, text };
    case "stall": {
      const ms = Number(args[0]);
      if (!Number.isFinite(ms) || ms < 0)
        throw new Error(`bad stall duration in "${text}"`);
      return { action: { kind: "stall", ms }, once, text };
    }
    default:
      throw new Error(`unknown failpoint action "${text}"`);
  }
}

export class Failpoints {
  private armed = new Map<string, Armed>();

  constructor(
    spec?: string,
    private readonly known: readonly string[] = FAILPOINT_NAMES,
    private readonly exit: (code: number) => never = (code) =>
      process.exit(code),
  ) {
    for (const entry of (spec ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const eq = entry.indexOf("=");
      if (eq < 1) throw new Error(`bad failpoint entry "${entry}"`);
      this.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
  }

  set(name: string, action: string): void {
    if (!this.known.includes(name))
      throw new Error(`unknown failpoint "${name}"`);
    this.armed.set(name, parseAction(action));
  }

  clear(name?: string): void {
    if (name) this.armed.delete(name);
    else this.armed.clear();
  }

  get anyActive(): boolean {
    return this.armed.size > 0;
  }

  /** For the internal health endpoint and the startup warning. */
  describe(): Record<string, string> {
    return Object.fromEntries([...this.armed].map(([k, v]) => [k, v.text]));
  }

  /** Call at the point. Returns "drop" if the caller should skip its step. */
  async hit(name: FailpointName): Promise<"drop" | undefined> {
    const a = this.armed.get(name);
    if (!a) return undefined;
    if (a.once) this.armed.delete(name);
    switch (a.action.kind) {
      case "exit":
        return this.exit(137);
      case "throw":
        throw new FailpointError(name);
      case "stall":
        await new Promise((r) =>
          setTimeout(r, (a.action as { ms: number }).ms),
        );
        return undefined;
      case "drop":
        return "drop";
    }
  }
}
