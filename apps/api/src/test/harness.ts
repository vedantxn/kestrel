import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_LIMITS } from "@kestrel/contracts";
import { createPrisma, type PrismaClient } from "@kestrel/db";
import {
  FakeClock,
  FsProfileStore,
  Failpoints,
  TokenSigner,
  TokenVerifier,
  createLogger,
  generateTokenKeys,
  type Logger,
} from "@kestrel/shared";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createApiKey } from "../auth.js";
import type { NodeConfig } from "../config.js";
import type { Ctx } from "../context.js";
import { buildInternalApp, buildPublicApp } from "../http.js";
import { newUuid } from "../ids.js";
import { createMetrics } from "../metrics.js";
import { RateLimiter } from "../rate-limit.js";
import { Sweeper } from "../sweeper.js";
import { FakeNode, FakeNodeClient } from "./fake-node.js";

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://kestrel:kestrel@localhost:5432/kestrel_test";

export interface Env {
  ctx: Ctx;
  db: PrismaClient;
  clock: FakeClock;
  failpoints: Failpoints;
  api: FastifyInstance;
  internal: FastifyInstance;
  sweeper: Sweeper;
  verifier: TokenVerifier;
  nodes: Record<string, FakeNode>;
  nodeClient: FakeNodeClient;
  projectId: string;
  key: string;
  /** A second project with its own key, for cross-project checks. */
  project2: { projectId: string; key: string };
  /** Create a session through the HTTP API. */
  create(
    body?: Record<string, unknown>,
    key?: string,
  ): Promise<LightMyRequestResponse>;
  call(
    method: "GET" | "POST" | "DELETE",
    url: string,
    key?: string,
  ): Promise<LightMyRequestResponse>;
  /** Heartbeat every node. */
  syncAll(): Promise<void>;
  close(): Promise<void>;
}

export interface EnvOptions {
  nodes?: { id: string; slots: number }[];
  maxConcurrentSessions?: number;
  createsPerMinute?: number;
  nodeCallTimeoutMs?: number;
  failpoints?: string;
  log?: Logger;
  captchaSolver?: Ctx["captchaSolver"];
  /** P18: give the deployment profiles, with a store in a fresh temporary directory. */
  profiles?: boolean | { maxBytes?: number };
}

const TABLES = [
  "profile_versions",
  "profiles",
  "session_events",
  "sessions",
  "idempotency_keys",
  "api_keys",
  "nodes",
  "projects",
  "orgs",
];

export async function resetDb(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`,
  );
}

export async function makeEnv(opts: EnvOptions = {}): Promise<Env> {
  const db = createPrisma(DATABASE_URL, { max: 20 });
  await resetDb(db);

  const clock = new FakeClock();
  const failpoints = new Failpoints(opts.failpoints, undefined, ((
    code: number,
  ) => {
    throw new Error(`failpoint exit(${code})`);
  }) as never);
  const keys = await generateTokenKeys();
  const signer = await TokenSigner.fromPem(keys.privatePem);
  const verifier = await TokenVerifier.fromPem(keys.publicPem);

  const nodeSpecs = opts.nodes ?? [{ id: "a", slots: 5 }];
  const nodeConfigs = new Map<string, NodeConfig>(
    nodeSpecs.map((n, i) => [
      n.id,
      {
        id: n.id,
        address: `http://127.0.0.1:${7001 + i}`,
        secret: `secret-for-node-${n.id}-0123456789`,
        connectPort: 8443 + i,
      },
    ]),
  );
  const nodes: Record<string, FakeNode> = {};
  for (const n of nodeSpecs) {
    nodes[n.id] = new FakeNode(
      n.id,
      (nodeConfigs.get(n.id) as NodeConfig).secret,
      n.slots,
      1,
      () => new Date(clock.now()),
    );
  }
  const nodeClient = new FakeNodeClient(new Map(Object.entries(nodes)));

  const now = new Date(clock.now());
  const orgId = newUuid();
  await db.org.create({ data: { id: orgId, name: "test" } });
  const projectId = newUuid();
  await db.project.create({
    data: {
      id: projectId,
      orgId,
      name: "one",
      maxConcurrentSessions: opts.maxConcurrentSessions ?? 20,
      createsPerMinute: opts.createsPerMinute ?? 300,
    },
  });
  const project2Id = newUuid();
  await db.project.create({ data: { id: project2Id, orgId, name: "two" } });
  const { key } = await createApiKey(db, projectId, "test", now);
  const { key: key2 } = await createApiKey(db, project2Id, "test2", now);

  const ctx: Ctx = {
    db,
    clock,
    log: opts.log ?? createLogger("test", "silent"),
    failpoints,
    signer,
    nodeClient,
    nodes: nodeConfigs,
    publicHostname: "1-2-3-4.sslip.io",
    metrics: createMetrics(),
    rateLimiter: new RateLimiter(clock),
    nodeCallTimeoutMs: opts.nodeCallTimeoutMs ?? 200,
    state: { waiters: 0, waitersByProject: new Map() },
    monotonic: () => clock.now(),
    ...(opts.captchaSolver ? { captchaSolver: opts.captchaSolver } : {}),
    ...(opts.profiles
      ? {
          profiles: {
            store: new FsProfileStore(mkdtempSync(join(tmpdir(), "kpf-api-"))),
            master: randomBytes(32),
            maxBytes:
              (typeof opts.profiles === "object" && opts.profiles.maxBytes) ||
              PROFILE_LIMITS.maxBytes,
          },
        }
      : {}),
  };
  const sweeper = new Sweeper(ctx);
  const api = buildPublicApp(ctx);
  const internal = buildInternalApp(ctx, sweeper);
  await api.ready();
  await internal.ready();

  for (const n of Object.values(nodes)) await n.register(internal);
  // Registration counts as a first heartbeat; a real agent follows with one at once.
  for (const n of Object.values(nodes)) await n.heartbeat(internal);

  const env: Env = {
    ctx,
    db,
    clock,
    failpoints,
    api,
    internal,
    sweeper,
    verifier,
    nodes,
    nodeClient,
    projectId,
    key,
    project2: { projectId: project2Id, key: key2 },
    create: (body = {}, k = key) =>
      api.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: body,
        headers: { authorization: `Bearer ${k}` },
      }),
    call: (method, url, k = key) =>
      api.inject({ method, url, headers: { authorization: `Bearer ${k}` } }),
    syncAll: async () => {
      for (const n of Object.values(nodes)) await n.sync(internal);
    },
    close: async () => {
      sweeper.stop();
      await api.close();
      await internal.close();
      await db.$disconnect();
    },
  };
  return env;
}
