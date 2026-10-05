import { readFileSync as readSecretFile } from "node:fs";
import {
  EventBody,
  NodeId,
  SessionOptions,
  type CaptchaProvider,
  type EndReason,
  type SessionStatus,
} from "@kestrel/contracts";
import { createPrisma } from "@kestrel/db";
import { createApiKey } from "./auth.js";
import { newUuid } from "./ids.js";

/**
 * Sample sessions for building the dashboard (P17) without nodes: `npm run seed:demo -w @kestrel/api`.
 * It writes only to a database named `*_dev`, into the "default" project (made if absent),
 * and prints a key for that project when it has none it can show.
 */
if (!process.env.DATABASE_URL && process.env.DATABASE_URL_FILE)
  process.env.DATABASE_URL = readSecretFile(
    process.env.DATABASE_URL_FILE,
    "utf8",
  ).trim();
const url =
  process.env.DATABASE_URL ??
  "postgresql://kestrel:kestrel@localhost:5432/kestrel_dev";
if (!/_dev(\?|$)/.test(url))
  throw new Error(`refusing to seed a database not named *_dev: ${url}`);

const db = createPrisma(url, { max: 2 });

// A small seeded generator, so two runs make the same shapes.
let state = 20261005;
const rand = (): number => {
  state = (state * 1103515245 + 12345) % 2 ** 31;
  return state / 2 ** 31;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const HOSTS = [
  "news.ycombinator.com",
  "www.amazon.com",
  "github.com",
  "www.linkedin.com",
  "docs.python.org",
  "www.zillow.com",
  "www.booking.com",
];
const CAPTCHAS: CaptchaProvider[] = [
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "cloudflare_challenge",
];
const AGENTS = ["browser-use", "stagehand", "claude", "scraper", "playwright"];

try {
  const org =
    (await db.org.findFirst({ orderBy: { createdAt: "asc" } })) ??
    (await db.org.create({ data: { id: newUuid(), name: "default" } }));
  const project =
    (await db.project.findFirst({
      where: { orgId: org.id, name: "default" },
    })) ??
    (await db.project.create({
      data: { id: newUuid(), orgId: org.id, name: "default" },
    }));
  let key = await db.apiKey.findFirst({
    where: { projectId: project.id, revokedAt: null },
  });
  if (!key) {
    const made = await createApiKey(db, project.id, "seed", new Date(), {
      admin: true,
    });
    key = made.row;
    console.log(`Admin key for project "default", shown once:\n${made.key}`);
  }

  for (const [id, slots] of [
    ["a", 8],
    ["b", 4],
  ] as const) {
    await db.node.upsert({
      where: { id },
      create: {
        id,
        address: `http://127.0.0.1:${id === "a" ? 7001 : 7002}`,
        slotsTotal: slots,
        hotCount: id === "a" ? 3 : 1,
        runtimeVersion: "seed",
        lastHeartbeatAt: new Date(),
      },
      update: {},
    });
  }

  const now = Date.now();
  const COUNT = 220;
  let made = 0;
  for (let i = 0; i < COUNT; i++) {
    // More sessions recently; a few still running.
    const durationS = Math.round(20 + rand() ** 1.5 * 1500);
    // Ended sessions ended in the past.
    const ageMs = Math.max(
      Math.floor(rand() ** 2 * 30 * 86_400_000),
      durationS * 1000 + 60_000,
    );
    const live = i < 4;
    const createdAt = new Date(live ? now - (i + 1) * 90_000 : now - ageMs);
    const failed = !live && rand() < 0.07;
    const startPath = rand() < 0.85 ? "hot" : "cold";
    const readyMs = Math.round(
      startPath === "hot" ? 60 + rand() * 120 : 1200 + rand() * 900,
    );
    const nodeId = NodeId.parse(rand() < 0.7 ? "a" : "b");
    const host = pick(HOSTS);
    const captcha = rand() < 0.12 ? pick(CAPTCHAS) : null;
    const endReason: EndReason | null = live
      ? null
      : failed
        ? pick(["start_timeout", "runtime_crash", "browser_crash"] as const)
        : pick([
            "client_stop",
            "client_stop",
            "client_stop",
            "client_disconnect",
            "idle_timeout",
            "max_lifetime",
          ] as const);
    const status: SessionStatus = live
      ? i === 0
        ? "active"
        : "ready"
      : failed
        ? "failed"
        : endReason === "max_lifetime"
          ? "timed_out"
          : "stopped";
    const readyAt = failed
      ? null
      : new Date(createdAt.getTime() + readyMs + 20);
    const endedAt = live
      ? null
      : new Date(
          (readyAt ?? createdAt).getTime() +
            (failed ? 30_000 : durationS * 1000),
        );
    const options = SessionOptions.parse({
      recording: rand() < 0.25,
      metadata: { agent: pick(AGENTS), task: `task-${1000 + i}` },
      ...(rand() < 0.2
        ? {
            proxy: {
              server: "http://proxy.example.net:8080",
              username: "user-42",
            },
          }
        : {}),
      ...(rand() < 0.15 ? { network: { allow: [host, `*.${host}`] } } : {}),
    });

    const id = newUuid();
    await db.session.create({
      data: {
        id,
        projectId: project.id,
        apiKeyId: key.id,
        status,
        endReason,
        options,
        nodeId,
        nodeEpoch: 1,
        startPath: failed ? null : startPath,
        browserSeconds: failed || live ? 0 : durationS,
        createdAt,
        readyAt,
        stoppingAt: endedAt ? new Date(endedAt.getTime() - 300) : null,
        endedAt,
        captcha:
          live && captcha
            ? { providers: [captcha], since: createdAt.toISOString() }
            : undefined,
      },
    });

    const t0 = createdAt.getTime();
    const events: { at: number; body: EventBody }[] = [
      { at: t0, body: { type: "session.requested", data: {} } },
      { at: t0 + 2, body: { type: "session.scheduled", data: { nodeId } } },
      { at: t0 + 5, body: { type: "session.starting", data: {} } },
    ];
    if (readyAt) {
      const r = readyAt.getTime();
      events.push(
        {
          at: r,
          body: { type: "session.ready", data: { startPath, readyMs } },
        },
        {
          at: r + 400,
          body: { type: "session.attached", data: { connections: 1 } },
        },
      );
      if (captcha)
        events.push({
          at: r + 8_000,
          body: {
            type: "captcha.detected",
            data: { provider: captcha, host, present: [captcha] },
          },
        });
      if (captcha && !live)
        events.push({
          at: r + 45_000,
          body: {
            type: "captcha.cleared",
            data: { provider: captcha, present: [] },
          },
        });
      if (rand() < 0.15)
        events.push({
          at: r + 12_000,
          body: {
            type: "egress.denied",
            data: {
              host: "169.254.169.254",
              port: 80,
              reason: "blocked_address",
              count: 1,
            },
          },
        });
    }
    if (endedAt && endReason) {
      const e = endedAt.getTime();
      if (readyAt)
        events.push({
          at: e - 600,
          body: { type: "session.detached", data: { connections: 0 } },
        });
      if (failed && endReason !== "start_timeout")
        events.push({
          at: e - 500,
          body: {
            type: "runtime.crashed",
            data: { process: "chrome", exitCode: null, signal: "SIGSEGV" },
          },
        });
      events.push(
        {
          at: e - 300,
          body: { type: "session.stopping", data: { endReason } },
        },
        { at: e, body: { type: "session.ended", data: { endReason, status } } },
      );
    }
    await db.sessionEvent.createMany({
      data: events
        .sort((a, b) => a.at - b.at)
        .map((ev) => ({
          id: newUuid(),
          sessionId: id,
          type: ev.body.type,
          data: EventBody.parse(ev.body).data,
          at: new Date(ev.at),
        })),
    });
    made++;
  }
  console.log(`seeded ${made} sessions into project "default"`);
} finally {
  await db.$disconnect();
}
