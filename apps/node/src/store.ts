import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import Database from "better-sqlite3";
import type {
  EndReason,
  NetworkPolicy,
  Report,
  Viewport,
} from "@kestrel/contracts";

export type BindingState = "starting" | "ready" | "stopping";

export interface Binding {
  sessionId: string;
  projectId: string;
  state: BindingState;
  containerId: string | null;
  address: string | null;
  proof: string | null;
  controlToken: string | null;
  policy: NetworkPolicy;
  viewport: Viewport;
  stopOnDisconnect: boolean;
  timeoutMs: number;
  idleTimeoutMs: number;
  createdAt: number;
  readyAt: number | null;
  /** Absolute lifetime deadline, on this agent's clock (G11). */
  maxAt: number;
  /** Absolute idle deadline; null while a client is attached. */
  idleAt: number | null;
  attached: number;
  stopReason: EndReason | null;
  startPath: "hot" | "cold" | null;
}

export interface PoolEntry {
  containerId: string;
  address: string;
  controlToken: string;
  state: "starting" | "hot";
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL,
  container_id TEXT,
  address TEXT,
  proof TEXT,
  control_token TEXT,
  policy TEXT NOT NULL,
  viewport TEXT NOT NULL,
  stop_on_disconnect INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  idle_timeout_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  max_at INTEGER NOT NULL,
  idle_at INTEGER,
  attached INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  start_path TEXT
);
CREATE TABLE IF NOT EXISTS pool (
  container_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  control_token TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  seq INTEGER PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stops (session_id TEXT PRIMARY KEY, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS recordings (
  session_id TEXT PRIMARY KEY,
  volume TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/**
 * G2, G15. The agent's durable memory, written before a start is acknowledged. It holds what
 * is needed to rebuild after a crash without asking `runtimed` anything (the container is
 * untrusted): which container serves which session, the session's proof, absolute deadlines,
 * policy, the node's epoch, reports not yet acknowledged, and recently seen stops. Fully
 * synchronous writes in write-ahead-log mode: a committed row survives a power cut.
 */
export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    // The file holds session proofs and control tokens (threat model G-14): create it owner-only before
    // SQLite does, so it and its -wal and -shm files, which inherit its mode, are never world-readable.
    if (path !== ":memory:") {
      if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- meta -----------------------------------------------------------------------------------

  private getMeta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  get epoch(): number {
    return Number(this.getMeta("epoch") ?? 0);
  }
  set epoch(n: number) {
    this.setMeta("epoch", String(n));
  }

  // --- sessions -------------------------------------------------------------------------------

  private toBinding(r: Record<string, unknown>): Binding {
    return {
      sessionId: r.session_id as string,
      projectId: r.project_id as string,
      state: r.state as BindingState,
      containerId: (r.container_id as string | null) ?? null,
      address: (r.address as string | null) ?? null,
      proof: (r.proof as string | null) ?? null,
      controlToken: (r.control_token as string | null) ?? null,
      policy: JSON.parse(r.policy as string),
      viewport: JSON.parse(r.viewport as string),
      stopOnDisconnect: r.stop_on_disconnect === 1,
      timeoutMs: r.timeout_ms as number,
      idleTimeoutMs: r.idle_timeout_ms as number,
      createdAt: r.created_at as number,
      readyAt: (r.ready_at as number | null) ?? null,
      maxAt: r.max_at as number,
      idleAt: (r.idle_at as number | null) ?? null,
      attached: r.attached as number,
      stopReason: (r.stop_reason as EndReason | null) ?? null,
      startPath: (r.start_path as "hot" | "cold" | null) ?? null,
    };
  }

  insertBinding(b: Binding): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, project_id, state, container_id, address, proof, control_token, policy, viewport,
          stop_on_disconnect, timeout_ms, idle_timeout_ms, created_at, ready_at, max_at, idle_at, attached, stop_reason, start_path)
         VALUES (@sessionId, @projectId, @state, @containerId, @address, @proof, @controlToken, @policy, @viewport,
          @stopOnDisconnect, @timeoutMs, @idleTimeoutMs, @createdAt, @readyAt, @maxAt, @idleAt, @attached, @stopReason, @startPath)`,
      )
      .run({
        ...b,
        policy: JSON.stringify(b.policy),
        viewport: JSON.stringify(b.viewport),
        stopOnDisconnect: b.stopOnDisconnect ? 1 : 0,
      });
  }

  updateBinding(
    sessionId: string,
    patch: Partial<Omit<Binding, "sessionId">>,
  ): void {
    const cols: Record<string, string> = {
      projectId: "project_id",
      state: "state",
      containerId: "container_id",
      address: "address",
      proof: "proof",
      controlToken: "control_token",
      readyAt: "ready_at",
      maxAt: "max_at",
      idleAt: "idle_at",
      attached: "attached",
      stopReason: "stop_reason",
      startPath: "start_path",
      idleTimeoutMs: "idle_timeout_ms",
      timeoutMs: "timeout_ms",
    };
    const sets: string[] = [];
    const values: Record<string, unknown> = { sessionId };
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) throw new Error(`cannot update ${k}`);
      sets.push(`${col} = @${k}`);
      values[k] = v;
    }
    if (sets.length)
      this.db
        .prepare(
          `UPDATE sessions SET ${sets.join(", ")} WHERE session_id = @sessionId`,
        )
        .run(values);
  }

  getBinding(sessionId: string): Binding | undefined {
    const r = this.db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    return r ? this.toBinding(r) : undefined;
  }

  allBindings(): Binding[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions ORDER BY created_at")
        .all() as Record<string, unknown>[]
    ).map((r) => this.toBinding(r));
  }

  deleteBinding(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  // --- pool -----------------------------------------------------------------------------------

  upsertPool(p: PoolEntry): void {
    this.db
      .prepare(
        `INSERT INTO pool (container_id, address, control_token, state, created_at) VALUES (@containerId, @address, @controlToken, @state, @createdAt)
         ON CONFLICT(container_id) DO UPDATE SET state = excluded.state`,
      )
      .run(p);
  }

  allPool(): PoolEntry[] {
    return (
      this.db.prepare("SELECT * FROM pool ORDER BY created_at").all() as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      containerId: r.container_id as string,
      address: r.address as string,
      controlToken: r.control_token as string,
      state: r.state as "starting" | "hot",
      createdAt: r.created_at as number,
    }));
  }

  deletePool(containerId: string): void {
    this.db.prepare("DELETE FROM pool WHERE container_id = ?").run(containerId);
  }

  /** Take a pooled container for a session. True only for the one caller whose delete removed the row. */
  takePool(containerId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM pool WHERE container_id = ?")
        .run(containerId).changes === 1
    );
  }

  // --- remembered stops (G14) -----------------------------------------------------------------

  rememberStop(sessionId: string, until: number): void {
    this.db
      .prepare(
        "INSERT INTO stops(session_id, until) VALUES(?, ?) ON CONFLICT(session_id) DO UPDATE SET until = excluded.until",
      )
      .run(sessionId, until);
  }

  isStopRemembered(sessionId: string, now: number): boolean {
    this.db.prepare("DELETE FROM stops WHERE until < ?").run(now);
    return (
      this.db
        .prepare("SELECT 1 FROM stops WHERE session_id = ?")
        .get(sessionId) !== undefined
    );
  }

  // --- reports (G15) --------------------------------------------------------------------------

  /**
   * Queue a report. Ids come from a counter that is never reused, even across restarts, because
   * the API de-duplicates on `<node>:<id>`: a reused id would get a real report dropped.
   */
  enqueueReport(make: (id: string) => Report): Report {
    const tx = this.db.transaction(() => {
      const n = Number(this.getMeta("report_counter") ?? 0) + 1;
      this.setMeta("report_counter", String(n));
      const report = make(`r${n}`);
      this.db
        .prepare("INSERT INTO reports(seq, id, body) VALUES(?, ?, ?)")
        .run(n, report.id, JSON.stringify(report));
      return report;
    });
    return tx();
  }

  pendingReports(limit = 100): Report[] {
    return (
      this.db
        .prepare("SELECT body FROM reports ORDER BY seq LIMIT ?")
        .all(limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }

  pendingReportCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM reports").get() as {
        n: number;
      }
    ).n;
  }

  /**
   * Delete a binding and queue its `removed` report in one transaction, so a crash cannot lose the
   * report (and leave the API to guess why the session ended).
   */
  finishBinding(sessionId: string, make: (id: string) => Report): Report {
    return this.db.transaction(() => {
      this.deleteBinding(sessionId);
      return this.enqueueReport(make);
    })();
  }

  /**
   * Queue an event report unless the queue is already full. Events are the only reports that may
   * be dropped: a `removed` report is never dropped, and never waits behind more than this many events.
   */
  enqueueEvent(make: (id: string) => Report): Report | null {
    if (this.pendingReportCount() >= Store.MAX_PENDING_EVENTS) return null;
    return this.enqueueReport(make);
  }

  /** Event reports are dropped beyond this many pending (a flapping client must not grow the queue without bound). */
  static readonly MAX_PENDING_EVENTS = 2000;

  ackReports(ids: string[]): void {
    const del = this.db.prepare("DELETE FROM reports WHERE id = ?");
    this.db.transaction(() => ids.forEach((id) => del.run(id)))();
  }

  // --- recordings (W3) ---------------------------------------------------------------------------

  /** A session that records keeps its container's volume after the container goes, until retention ends. */
  addRecording(sessionId: string, volume: string, createdAt: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO recordings(session_id, volume, created_at) VALUES(?, ?, ?)",
      )
      .run(sessionId, volume, createdAt);
  }

  getRecording(
    sessionId: string,
  ): { sessionId: string; volume: string; createdAt: number } | undefined {
    const r = this.db
      .prepare("SELECT * FROM recordings WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    return r
      ? {
          sessionId: r.session_id as string,
          volume: r.volume as string,
          createdAt: r.created_at as number,
        }
      : undefined;
  }

  allRecordings(): { sessionId: string; volume: string; createdAt: number }[] {
    return (
      this.db.prepare("SELECT * FROM recordings").all() as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      sessionId: r.session_id as string,
      volume: r.volume as string,
      createdAt: r.created_at as number,
    }));
  }

  deleteRecording(sessionId: string): void {
    this.db
      .prepare("DELETE FROM recordings WHERE session_id = ?")
      .run(sessionId);
  }
}
