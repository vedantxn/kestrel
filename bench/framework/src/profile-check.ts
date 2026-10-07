import { readFileSync } from "node:fs";
import type { NodeState, ProfileId, Session } from "@kestrel/contracts";
import { ApiError, KestrelClient } from "./client.js";
import { agentState, settledInvariants, type HostConfig } from "./collect.js";
import { readProfileStoreDir } from "./collect-profiles.js";
import { classify, listProcesses, realHost } from "./collect-vm.js";
import { inContainer, KILL_BY } from "./chaos.js";
import { runWarmCloneDiff } from "./clones.js";
import { checkInvariants } from "./invariants.js";
import { m1ConfigFromEnv } from "./m1.js";
import { nodeRuntimes, sessionsOn } from "./placement.js";
import {
  classifyMarks,
  compareMarks,
  fillIndexedDb,
  markValues,
  newMarks,
  openOn,
  readMarks,
  writeMarks,
  type Marks,
  type Opened,
} from "./profile-data.js";
import {
  agentStore,
  dataKey,
  findNeedles,
  keyNeedle,
  nodeFailpointVar,
  openVersion,
  otherProjectKey,
  platformLogs,
  postgresDump,
  composeArgs,
  recreate,
  run as sh,
  storeFiles,
  textNeedle,
  versionRows,
  type HostPaths,
} from "./profile-host.js";
import { makeReport, type Report } from "./report.js";
import { summarize } from "./stats.js";

/**
 * `bench profiles` (docs/lld/p18-profiles.md section 10): the profile acceptance checks, run on
 * the host against the real deployment, node a on microVMs and node b on Docker. Each check
 * writes random values (`profile-data.ts`) into a writer session from the harness's own client,
 * stops it cleanly, waits for `profile.saved`, and reads them back in a reader. A check that
 * needs a kind of node the deployment lacks says so and passes as not applicable.
 *
 * Check 10 (no regression) is `bench m1 QUICK=1` and `bench m2`, run separately. Check 11 does
 * not reboot the host: a reboot ends sessions `node_lost` without a save, which the API's tests
 * cover (`profile-lock.test.ts`); it is left to a run by hand.
 */
export interface ProfileCheckConfig {
  apiUrl: string;
  apiKey: string;
  testPageUrl: string;
  host: HostConfig;
  environment: Record<string, string | number>;
  only?: number[];
  /** Check 11's cases by name (`PROFILE_CHAOS_CASES`). */
  chaosOnly?: string[];
  log: (m: string) => void;
  /** Check 9: creates per node (the LLD's 50). */
  latencySamples: number;
  /** Check 9: the profile's size. */
  latencyProfileMib: number;
  /** Check 6: what the writer stores in IndexedDB, past the deployment's cap. */
  tooLargeMib: number;
  paths: HostPaths;
  /** Compose's view of the deployment, for the chaos cases' restarts. */
  compose: { runtimeA: string; twoNodes: boolean };
  /** Check 7's second project, made with the API's admin command. */
  otherProject: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ["stopped", "failed", "timed_out"] as const;
const CLEAN_IDLE = 1_800_000;

export async function until<T>(
  what: string,
  ms: number,
  fn: () => Promise<T | false | null | undefined>,
  everyMs = 250,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > end)
      throw new Error(
        `${what} did not happen within ${Math.round(ms / 1000)} s`,
      );
    await sleep(everyMs);
  }
}

// --- the parts that only need the API (tested against the real API in integration/) -------------

export type ProfileOutcome =
  | { type: "profile.saved"; version: number; bytes: number }
  | { type: "profile.save_failed"; reason: string };

/** A writer session's one save outcome, from its events. */
export async function awaitOutcome(
  client: KestrelClient,
  sessionId: string,
  ms = 90_000,
): Promise<ProfileOutcome> {
  return until(`a profile outcome for ${sessionId}`, ms, async () => {
    const e = (await client.eventList(sessionId)).find(
      (x) => x.type === "profile.saved" || x.type === "profile.save_failed",
    );
    if (!e) return false;
    return e.type === "profile.saved"
      ? {
          type: e.type,
          version: (e.data as { version: number }).version,
          bytes: (e.data as { bytes: number }).bytes,
        }
      : {
          type: "profile.save_failed",
          reason: (e.data as { reason: string }).reason,
        };
  });
}

/** Wait until no session holds the profile's write lock; its state then. */
export function lockFree(
  client: KestrelClient,
  profileId: ProfileId,
  ms = 60_000,
) {
  return until(`the lock on ${profileId} to be free`, ms, async () => {
    const p = await client.getProfile(profileId);
    return p.inUseBy === null ? p : false;
  });
}

const isProfileConflict = (e: unknown) =>
  e instanceof ApiError &&
  e.status === 409 &&
  e.code === "conflict" &&
  e.param === "profile.id";

/**
 * Check 4: `writers` concurrent creates with `persist: true` and `readers` without, at once.
 * Exactly one writer may start, every other must be refused `409 conflict` on `profile.id`
 * (retryable), every reader must start; once the writer has ended, a new writer must start
 * within `withinMs`.
 */
export async function singleWriter(
  client: KestrelClient,
  profileId: ProfileId,
  o: {
    writers: number;
    readers: number;
    withinMs: number;
    waitForCapacityMs?: number;
  },
): Promise<{ pass: boolean; detail: string; releaseMs: number | null }> {
  const create = (persist: boolean) =>
    client
      .create({
        profile: { id: profileId, persist },
        waitForCapacityMs: o.waitForCapacityMs ?? 30_000,
        idleTimeout: CLEAN_IDLE,
      })
      .then(
        (r) => ({ ok: true as const, session: r.session }),
        (e: unknown) => ({ ok: false as const, error: e }),
      );
  const results = await Promise.all([
    ...Array.from({ length: o.writers }, () => create(true)),
    ...Array.from({ length: o.readers }, () => create(false)),
  ]);
  const writers = results.slice(0, o.writers);
  const readers = results.slice(o.writers);
  const started = writers.flatMap((r) => (r.ok ? [r.session] : []));
  const refused = writers.filter((r) => !r.ok && isProfileConflict(r.error));
  const retryable = refused.every(
    (r) => !r.ok && (r.error as ApiError).retryable,
  );
  const other = writers.filter((r) => !r.ok && !isProfileConflict(r.error));
  const readersOk = readers.filter((r) => r.ok).length;
  const problems: string[] = [];
  if (started.length !== 1) problems.push(`${started.length} writers started`);
  if (refused.length !== o.writers - 1)
    problems.push(`${refused.length} refused 409 on profile.id`);
  if (!retryable) problems.push("a 409 was not retryable");
  if (other.length)
    problems.push(
      `others failed: ${other
        .map((r) =>
          r.ok ? "" : String((r.error as Error).message).slice(0, 80),
        )
        .join("; ")}`,
    );
  if (readersOk !== o.readers)
    problems.push(`${readersOk} of ${o.readers} readers started`);
  for (const r of readers)
    if (r.ok) await client.stop(r.session.id).catch(() => undefined);

  let releaseMs: number | null = null;
  if (started.length === 1) {
    const w = started[0]!;
    await client.stop(w.id);
    await client.waitFor(w.id, [...TERMINAL], 60_000, 50);
    const ended = Date.now();
    // A client that wants to write next retries its 409 at once, as the SDKs do with backoff.
    const next = await until(
      "a new writer to start",
      30_000,
      async () => {
        try {
          return (
            await client.create({ profile: { id: profileId, persist: true } })
          ).session;
        } catch (e) {
          if (isProfileConflict(e)) return false;
          throw e;
        }
      },
      25,
    );
    releaseMs = Date.now() - ended;
    await client.stop(next.id).catch(() => undefined);
    if (releaseMs > o.withinMs)
      problems.push(
        `the next writer started ${releaseMs} ms after the first ended`,
      );
  }
  return {
    pass: problems.length === 0,
    detail: problems.length
      ? problems.join("; ")
      : `1 of ${o.writers} writers started, ${o.writers - 1} refused 409 on profile.id (retryable), ${o.readers} readers alongside; the next writer started ${releaseMs} ms after the first ended`,
    releaseMs,
  };
}

/** Check 7, first half: another project's key, given this project's profile id, is told it does not exist. */
export async function crossProjectRefused(
  other: KestrelClient,
  profileId: ProfileId,
): Promise<string[]> {
  const problems: string[] = [];
  const notFound = (e: unknown) =>
    e instanceof ApiError && e.status === 404 && e.code === "not_found";
  for (const [what, call] of [
    [
      "a reader",
      () => other.create({ profile: { id: profileId, persist: false } }),
    ],
    [
      "a writer",
      () => other.create({ profile: { id: profileId, persist: true } }),
    ],
    ["a get", () => other.getProfile(profileId)],
    ["a delete", () => other.deleteProfile(profileId)],
  ] as const) {
    try {
      const r = await call();
      problems.push(`${what} succeeded`);
      if (r && typeof r === "object" && "session" in r)
        await other.stop(r.session.id).catch(() => undefined);
    } catch (e) {
      if (!notFound(e))
        problems.push(`${what}: ${(e as Error).message.slice(0, 80)}`);
      else if (
        what !== "a get" &&
        what !== "a delete" &&
        (e as ApiError).param !== "profile.id"
      )
        problems.push(`${what}: 404 without param profile.id`);
    }
  }
  return problems;
}

/** Check 9's judgement: the LLD's budgets, by runtime. Samples are milliseconds. */
export function judgeWarmLatency(
  runtime: "docker" | "microvm",
  ms: number[],
): { pass: boolean; p50: number; p95: number; budget: string } {
  const s = summarize(ms);
  const [p50Max, p95Max] = runtime === "docker" ? [1000, 2000] : [1500, 3000];
  return {
    pass: ms.length > 0 && s.p50 <= p50Max && s.p95 <= p95Max,
    p50: s.p50,
    p95: s.p95,
    budget: `p50 <= ${p50Max} ms, p95 <= ${p95Max} ms`,
  };
}

// --- the run on the host ------------------------------------------------------------------------

export async function runProfileCheck(c: ProfileCheckConfig): Promise<Report> {
  const client = new KestrelClient(c.apiUrl, c.apiKey, 180_000);
  const report = makeReport("profiles-check", c.environment);
  const want = (n: number) => !c.only || c.only.includes(n);
  const runtimes = await nodeRuntimes(c.host);
  const nodeOf = (r: "docker" | "microvm") =>
    [...runtimes].find(([, x]) => x === r)?.[0];
  const dockerNode = nodeOf("docker");
  const vmNode = nodeOf("microvm");
  const master = readFileSync(c.paths.masterKeyFile);
  const profiles: ProfileId[] = [];
  const written: Marks[] = [];
  const check = async (id: string, name: string, fn: () => Promise<string>) => {
    c.log(`check ${id}: ${name}`);
    try {
      report.add({ id, name, pass: true, detail: await fn() });
    } catch (e) {
      report.add({
        id,
        name,
        pass: false,
        detail: (e as Error).message.slice(0, 900),
      });
    }
  };
  const notApplicable = (id: string, name: string, why: string) =>
    report.add({ id, name, pass: true, detail: `not applicable: ${why}` });

  const newProfile = async () => {
    const p = await client.createProfile({ metadata: { bench: "profiles" } });
    profiles.push(p.id);
    return p.id;
  };

  /**
   * Run `fn` with every other node full of plain sessions, so whatever it creates lands on `node`.
   * The API places a session itself (warm browsers for a restore, else hot ones, else free
   * slots); a profile writer cannot be placed by creating several and keeping one (only one may
   * write), so the others are filled instead.
   */
  const onNode = async <T>(
    node: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    if (!node) return fn();
    const fillers: Session[] = [];
    try {
      for (const n of c.host.nodes.filter((x) => x.id !== node)) {
        const st = await agentState(n);
        // A session being torn down frees its slot in a moment: it is filled too.
        const free =
          st.slotsTotal -
          st.sessions.filter((s) => s.state !== "stopping").length;
        if (free > 0)
          fillers.push(
            ...(await sessionsOn(
              client,
              n.id,
              free,
              { idleTimeout: CLEAN_IDLE },
              free * 3 + 8,
            )),
          );
      }
      return await fn();
    } finally {
      for (const s of fillers) await client.stop(s.id).catch(() => undefined);
      for (const s of fillers)
        await client
          .waitFor(s.id, [...TERMINAL], 60_000)
          .catch(() => undefined);
    }
  };

  const create = async (opts: Record<string, unknown>, node?: string) => {
    for (let attempt = 1; ; attempt++) {
      const { session } = await onNode(node, () =>
        client.create({
          waitForCapacityMs: 30_000,
          idleTimeout: CLEAN_IDLE,
          ...opts,
        }),
      );
      if (!node || session.nodeId === node) return session;
      // A slot freed on another node between filling it and the create: stop it (a writer saves,
      // which a later writer of the profile builds on) and try again.
      await client.stop(session.id).catch(() => undefined);
      await client
        .waitFor(session.id, [...TERMINAL], 60_000)
        .catch(() => undefined);
      if (opts.profile && (opts.profile as { persist?: boolean }).persist)
        await awaitOutcome(client, session.id).catch(() => undefined);
      if (attempt >= 3)
        throw new Error(
          `a session meant for node ${node} landed on ${session.nodeId}, ${attempt} times`,
        );
    }
  };

  /** A writer: write (if asked) from the harness's client, stop cleanly, and return its outcome. */
  const write = async (
    profileId: ProfileId,
    node: string | undefined,
    fn?: (o: Opened) => Promise<void>,
  ): Promise<{ session: Session; outcome: ProfileOutcome }> => {
    const session = await create(
      { profile: { id: profileId, persist: true } },
      node,
    );
    try {
      if (fn) {
        const o = await openOn(session, c.testPageUrl);
        try {
          await fn(o);
        } finally {
          await o.browser.close().catch(() => undefined);
        }
      }
    } finally {
      await client.stop(session.id).catch(() => undefined);
    }
    return { session, outcome: await awaitOutcome(client, session.id) };
  };

  /** Save `m` into a profile from a writer on `node`; fails unless it is saved. */
  const save = async (
    profileId: ProfileId,
    node: string | undefined,
    m: Marks,
  ) => {
    let partitioned = false;
    const w = await write(profileId, node, async (o) => {
      ({ partitioned } = await writeMarks(o, m));
      const back = compareMarks(m, await readMarks(o, m), { partitioned });
      if (!back.ok)
        throw new Error(
          `the writer itself does not hold what it wrote: ${back.items
            .filter((i) => !i.ok)
            .map((i) => `${i.item} ${i.detail}`)
            .join(", ")}`,
        );
    });
    written.push(m);
    if (w.outcome.type !== "profile.saved")
      throw new Error(
        `the writer on ${w.session.nodeId} was not saved: ${w.outcome.reason}`,
      );
    await lockFree(client, profileId);
    return { ...w, partitioned, version: w.outcome.version };
  };

  /** Read the marks' names back in a reader on `node`. */
  const read = async (
    profileId: ProfileId,
    node: string | undefined,
    m: Marks,
  ) => {
    const session = await create({ profile: { id: profileId } }, node);
    try {
      const o = await openOn(session, c.testPageUrl);
      try {
        return { session, back: await readMarks(o, m) };
      } finally {
        await o.browser.close().catch(() => undefined);
      }
    } finally {
      await client.stop(session.id).catch(() => undefined);
    }
  };

  /** A reader must start warm, be told it restored this version, and hold every mark. */
  const readBack = async (
    profileId: ProfileId,
    node: string | undefined,
    m: Marks,
    version: number,
    partitioned: boolean,
  ): Promise<string> => {
    const r = await read(profileId, node, m);
    const problems: string[] = [];
    if (r.session.startPath !== "warm")
      problems.push(`started ${r.session.startPath}`);
    const restored = (await client.eventList(r.session.id)).find(
      (e) => e.type === "profile.restored",
    );
    const data = restored?.data as
      { version: number; bytes: number; ms: number } | undefined;
    if (data?.version !== version)
      problems.push(
        `restored ${data ? `version ${data.version}` : "nothing"}, wanted ${version}`,
      );
    const cmp = compareMarks(m, r.back, { partitioned });
    for (const i of cmp.items)
      if (!i.ok) problems.push(`${i.item}: ${i.detail}`);
    if (problems.length)
      throw new Error(`reader on ${r.session.nodeId}: ${problems.join("; ")}`);
    return `read on ${r.session.nodeId}: ${cmp.items.map((i) => i.item).join(", ")}; restored version ${version} (${data!.bytes} bytes) in ${Math.round(data!.ms)} ms`;
  };

  /** One profile saved on each node, for checks 1 to 3. */
  const savedOn = new Map<
    string,
    { profileId: ProfileId; m: Marks; version: number; partitioned: boolean }
  >();
  const saveOn = async (node: string) => {
    const have = savedOn.get(node);
    if (have) return have;
    const profileId = await newProfile();
    const m = newMarks();
    const s = await save(profileId, node, m);
    if (s.session.nodeId !== node)
      throw new Error(`the writer landed on ${s.session.nodeId}, not ${node}`);
    const out = {
      profileId,
      m,
      version: s.version,
      partitioned: s.partitioned,
    };
    savedOn.set(node, out);
    return out;
  };

  /** A profile whose current version holds `m`, written on any node. */
  const based = async (m: Marks) => {
    const profileId = await newProfile();
    const s = await save(profileId, undefined, m);
    return { profileId, version: s.version, partitioned: s.partitioned };
  };

  try {
    // --- 1, 2: a round trip on each runtime ---
    for (const [id, runtime, node] of [
      ["1", "docker", dockerNode],
      ["2", "microvm", vmNode],
    ] as const) {
      const name = `profiles.roundtrip.${runtime}: a writer's session, HttpOnly and partitioned cookies, localStorage and IndexedDB come back in a reader on the same node, started warm`;
      if (!want(Number(id))) continue;
      if (!node) {
        notApplicable(id, name, `no ${runtime} node in this deployment`);
        continue;
      }
      await check(id, name, async () => {
        const s = await saveOn(node);
        return `saved on ${node} as version ${s.version}${s.partitioned ? "" : " (Chrome kept no partitioned cookie: not judged)"}; ${await readBack(s.profileId, node, s.m, s.version, s.partitioned)}`;
      });
    }

    // --- 3: across runtimes ---
    if (want(3)) {
      const name =
        "profiles.cross_runtime: saved on the microVM node and read on the Docker node, and the reverse";
      if (!dockerNode || !vmNode)
        notApplicable(
          "3",
          name,
          "the deployment does not have both a microVM and a Docker node",
        );
      else {
        const pairs: [string, string][] = [
          [vmNode, dockerNode],
          [dockerNode, vmNode],
        ];
        await check("3", name, async () => {
          const out: string[] = [];
          for (const [from, to] of pairs) {
            const s = await saveOn(from);
            out.push(
              `${from} to ${to}: ${await readBack(s.profileId, to, s.m, s.version, s.partitioned)}`,
            );
          }
          return out.join("; ");
        });
      }
    }

    // --- 4: one writer ---
    if (want(4))
      await check(
        "4",
        "profiles.single_writer: of 10 concurrent writers exactly 1 starts and 9 get 409 on profile.id, 5 readers start alongside, and a new writer starts within 1 s of the first ending",
        async () => {
          const profileId = await newProfile();
          const r = await singleWriter(client, profileId, {
            writers: 10,
            readers: 5,
            withinMs: 1000,
          });
          report.measure("singleWriterReleaseMs", r.releaseMs);
          if (!r.pass) throw new Error(r.detail);
          await lockFree(client, profileId);
          return r.detail;
        },
      );

    // --- 5: an unclean end ---
    if (want(5))
      await check(
        "5",
        "profiles.unclean_end: killing Chrome in a writer leaves the version unchanged, writes profile.save_failed (unclean_end) and frees the lock",
        async () => {
          const out: string[] = [];
          for (const node of [dockerNode, vmNode].filter((x): x is string =>
            Boolean(x),
          )) {
            const a = newMarks();
            const base = await based(a);
            const session = await create(
              { profile: { id: base.profileId, persist: true } },
              node,
            );
            const o = await openOn(session, c.testPageUrl);
            await writeMarks(o, newMarks());
            const how = await killChrome(c.host, o);
            await o.browser.close().catch(() => undefined);
            const ended = await client.waitFor(
              session.id,
              [...TERMINAL],
              60_000,
            );
            const outcome = await awaitOutcome(client, session.id);
            const p = await lockFree(client, base.profileId);
            const problems: string[] = [];
            if (
              !["browser_crash", "runtime_crash"].includes(
                ended.endReason ?? "",
              )
            )
              problems.push(`ended ${ended.status}/${ended.endReason}`);
            if (
              outcome.type !== "profile.save_failed" ||
              outcome.reason !== "unclean_end"
            )
              problems.push(`outcome ${JSON.stringify(outcome)}`);
            if (p.version !== base.version)
              problems.push(
                `the profile is at version ${p.version}, was ${base.version}`,
              );
            if (problems.length)
              throw new Error(`node ${node}: ${problems.join("; ")}`);
            out.push(
              `node ${node}: Chrome ${how}; ended ${ended.endReason}; save_failed unclean_end; still version ${p.version}; lock free`,
            );
          }
          if (!out.length) throw new Error("no node to run on");
          return out.join("; ");
        },
      );

    // --- 6: too large ---
    if (want(6))
      await check(
        "6",
        `profiles.too_large: a writer that stores ${c.tooLargeMib} MiB in IndexedDB gets too_large; the previous version stays current and restores`,
        async () => {
          const a = newMarks();
          const base = await based(a);
          const w = await write(base.profileId, undefined, async (o) => {
            await fillIndexedDb(o.page, c.tooLargeMib);
          });
          if (
            w.outcome.type !== "profile.save_failed" ||
            w.outcome.reason !== "too_large"
          )
            throw new Error(
              `the big writer's outcome: ${JSON.stringify(w.outcome)}`,
            );
          const p = await lockFree(client, base.profileId);
          if (p.version !== base.version)
            throw new Error(
              `the profile is at version ${p.version}, was ${base.version}`,
            );
          return `save_failed too_large on ${w.session.nodeId}; still version ${p.version}; ${await readBack(base.profileId, undefined, a, base.version, base.partitioned)}`;
        },
      );

    // --- 7: isolation at rest ---
    if (want(7))
      await check(
        "7",
        "profiles.isolation_at_rest: another project's create with this profile's id is 404; no cookie value or data key in the store, Postgres, the agents' stores or the logs",
        async () => {
          const m = newMarks();
          const own = await based(m);
          // One reader too, so a restore key has been sent and used.
          await read(own.profileId, undefined, m);
          const problems: string[] = [];
          const other = await otherProjectKey(
            c.paths.databaseUrlFile,
            c.otherProject,
          );
          try {
            for (const p of await crossProjectRefused(
              new KestrelClient(c.apiUrl, other.key, 60_000),
              own.profileId,
            ))
              problems.push(`project B: ${p}`);
          } finally {
            await other.revoke().catch(() => undefined);
          }
          const rows = await versionRows(c.paths, profiles);
          const kinds = [
            "session cookie",
            "persistent cookie",
            "HttpOnly cookie",
            "partitioned cookie",
            "localStorage value",
            "IndexedDB value",
          ];
          const needles = [
            ...written.flatMap((x, i) =>
              markValues(x).map((v, j) =>
                textNeedle(`write ${i + 1}'s ${kinds[j]}`, v),
              ),
            ),
            ...rows.map((r) =>
              keyNeedle(
                `${r.profileId} v${r.version}'s data key`,
                dataKey(master, r),
              ),
            ),
            keyNeedle("the master key", master),
          ];
          const hay = [
            ...(await storeFiles(c.paths.storeDir)),
            await postgresDump(),
            ...(await Promise.all(c.host.nodes.map((n) => agentStore(n.id)))),
            ...(await platformLogs()),
          ];
          for (const f of findNeedles(needles, hay))
            problems.push(`${f.label} in ${f.where}`);
          if (problems.length)
            throw new Error(problems.slice(0, 12).join("; "));
          return `404 for project B's reader, writer, get and delete; none of ${needles.length} values and keys (${written.length} runs' marks, ${rows.length} versions' keys) in ${hay.length} places: the store's files, Postgres, ${c.host.nodes.length} agent stores, the platform's logs`;
        },
      );

    // --- 8: warm clones ---
    if (want(8)) {
      const name =
        "profiles.warm_clones_unique: m1 check 4b's clone comparison, on two warm clones (no shared page randomness; clock within 2 s)";
      if (!vmNode)
        notApplicable("8", name, "no microVM node in this deployment");
      else
        await check("8", name, async () => {
          // A saved version that holds nothing of the test page's origin: a writer that never loads a page.
          const profileId = await newProfile();
          const w = await write(profileId, undefined);
          if (w.outcome.type !== "profile.saved")
            throw new Error(
              `the empty writer was not saved: ${w.outcome.reason}`,
            );
          await lockFree(client, profileId);
          const d = await runWarmCloneDiff(
            client,
            c.host,
            c.testPageUrl,
            profileId,
          );
          if ("skipped" in d) return `not applicable: ${d.skipped}`;
          report.measure("warmClones", d);
          if (!d.pass)
            throw new Error(
              d.failures
                .slice(0, 6)
                .map((f) => `${f.item}: ${f.why}`)
                .join("; "),
            );
          return `node ${d.node}${d.baseline ? ", against two warm containers" : ", no Docker node for a baseline"}: ${d.uniqueCount} items differ; ${d.shared.length} the same and explained`;
        });
    }

    // --- 9: warm latency ---
    if (want(9))
      await check(
        "9",
        `profiles.warm_latency: ${c.latencySamples} sequential creates per node with a ${c.latencyProfileMib} MiB profile, at the API (Docker p50 <= 1000 ms, p95 <= 2000 ms with a warm container; microVM p50 <= 1500 ms, p95 <= 3000 ms)`,
        async () => {
          const profileId = await newProfile();
          const m = newMarks();
          const w = await write(profileId, undefined, async (o) => {
            await writeMarks(o, m);
            await fillIndexedDb(o.page, c.latencyProfileMib);
          });
          written.push(m);
          if (w.outcome.type !== "profile.saved")
            throw new Error(`the profile was not saved: ${w.outcome.reason}`);
          await lockFree(client, profileId);
          const out: string[] = [];
          let ok = true;
          for (const [runtime, node] of [
            ["docker", dockerNode],
            ["microvm", vmNode],
          ] as const) {
            if (!node) {
              out.push(`${runtime}: no such node`);
              continue;
            }
            const n = c.host.nodes.find((x) => x.id === node)!;
            const samples: {
              ms: number;
              path: string | null;
              node: string | null;
              warmBefore: number;
            }[] = [];
            await onNode(node, async () => {
              for (let i = 0; i < c.latencySamples; i++) {
                // The budget is for a pool that keeps up: on Docker, wait for a warm container.
                const warmBefore =
                  runtime === "docker"
                    ? await until("a warm container", 20_000, async () => {
                        const d = await describeNode(n);
                        return (d.warmCount ?? 0) >= 1
                          ? (d.warmCount ?? 0)
                          : false;
                      }).catch(() => 0)
                    : 0;
                const t0 = performance.now();
                const { session } = await client.create({
                  profile: { id: profileId, persist: false },
                  idleTimeout: CLEAN_IDLE,
                });
                samples.push({
                  ms: Math.round(performance.now() - t0),
                  path: session.startPath,
                  node: session.nodeId,
                  warmBefore,
                });
                await client.stop(session.id);
                await client.waitFor(session.id, [...TERMINAL], 60_000);
              }
            });
            const wrong = samples.filter(
              (s) => s.path !== "warm" || s.node !== node,
            );
            const judged = samples.filter(
              (s) => runtime !== "docker" || s.warmBefore > 0,
            );
            const j = judgeWarmLatency(
              runtime,
              judged.map((s) => s.ms),
            );
            report.measure(
              `warmCreateMs.${runtime}`,
              summarize(samples.map((s) => s.ms)),
            );
            report.measure(`warmCreateSamples.${runtime}`, samples);
            if (!j.pass || wrong.length) ok = false;
            out.push(
              `${runtime} (node ${node}): p50 ${j.p50} ms, p95 ${j.p95} ms over ${judged.length}${runtime === "docker" ? " with a warm container" : ""} (${j.budget})${wrong.length ? `; ${wrong.length} not warm or elsewhere` : ""}`,
            );
          }
          if (!ok) throw new Error(out.join("; "));
          return out.join("; ");
        },
      );

    // --- 10: not here ---
    report.measure(
      "noRegression",
      "check 10 (profiles.no_regression) is `bench m1 QUICK=1` and `bench m2`, run separately",
    );

    // --- 11: chaos ---
    if (want(11)) {
      const results: { id: string; pass: boolean; detail: string }[] = [];
      for (const k of CHAOS.filter(
        (x) => !c.chaosOnly || c.chaosOnly.includes(x.id),
      )) {
        c.log(`check 11: ${k.id}`);
        let pass = true;
        let detail: string;
        try {
          detail = await k.run({
            client,
            c,
            master,
            base: based,
            writer: (profileId) =>
              create({ profile: { id: profileId, persist: true } }),
            read,
            written,
          });
        } catch (e) {
          pass = false;
          detail = (e as Error).message;
        }
        const inv = await settledInvariants(checkInvariants, c.host, {
          timeoutMs: 60_000,
        });
        if (!inv.ok) {
          pass = false;
          detail += `; INVARIANTS: ${inv.violations
            .slice(0, 4)
            .map((v) => `${v.rule}: ${v.detail}`)
            .join(" | ")}`;
        }
        results.push({ id: k.id, pass, detail });
        c.log(
          `check 11: ${k.id} ${pass ? "pass" : "FAIL"}: ${detail.slice(0, 200)}`,
        );
      }
      report.measure("chaos", results);
      const failed = results.filter((r) => !r.pass);
      report.add({
        id: "11",
        name: `profiles.chaos: ${results.map((r) => r.id).join(", ")}; each leaves the profile at exactly the old or the new version, never torn, and the lock free (the host reboot is not run here: by hand)`,
        pass: results.length > 0 && failed.length === 0,
        detail: failed.length
          ? failed
              .map((r) => `${r.id}: ${r.detail}`)
              .join("; ")
              .slice(0, 900)
          : results
              .map((r) => `${r.id}: ${r.detail}`)
              .join("; ")
              .slice(0, 900),
      });
    }

    // A check that failed half way may have left a session running: end it, so check 12 judges
    // what its end leaves behind (its lock, its pending version) too.
    for (const s of await client.list("?limit=100").catch(() => []))
      if (!(TERMINAL as readonly string[]).includes(s.status))
        await client.stop(s.id).catch(() => undefined);

    // --- 12: invariants, before the run's profiles are deleted (a delete clears a lock) ---
    if (want(12))
      await check(
        "12",
        "profiles.invariants: no lock held or version pending for an ended session, no old temporary blob, no blob without a row past an hour, no warm browser past its target, and nothing else leaked",
        async () => {
          if (!(await readProfileStoreDir(c.paths.storeDir)))
            throw new Error(
              `the profile store is not mounted at ${c.paths.storeDir}`,
            );
          const r = await settledInvariants(checkInvariants, c.host, {
            timeoutMs: 60_000,
          });
          if (!r.ok)
            throw new Error(
              r.violations
                .slice(0, 8)
                .map((v) => `${v.rule}: ${v.detail}`)
                .join("; "),
            );
          return "nothing leaked or inconsistent; the profile rules hold";
        },
      );
  } finally {
    // The run's profiles go, their blobs with them.
    for (const id of profiles)
      await client.deleteProfile(id).catch(() => undefined);
  }
  return report.build();
}

// --- helpers on the host -------------------------------------------------------------------------

async function describeNode(
  n: HostConfig["nodes"][number],
): Promise<NodeState> {
  const secret = readFileSync(n.secretFile, "utf8").trim();
  const r = await fetch(`http://127.0.0.1:${n.agentPort}/v1/describe`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(4000),
  });
  return (await r.json()) as NodeState;
}

/** The browser serving a session, from its agent's own account. */
async function browserOf(host: HostConfig, sessionId: string) {
  for (const n of host.nodes) {
    const b = (await agentState(n)).sessions.find(
      (s) => s.sessionId === sessionId,
    );
    if (b?.containerId) return { node: n.id, id: b.containerId };
  }
  return null;
}

/**
 * Kill a session's Chrome the way a crash would: in a container, by its process; in a VM, from
 * the client (`Browser.crash`), and if that does not end it, by killing the VM's VMM.
 */
async function killChrome(host: HostConfig, o: Opened): Promise<string> {
  const where = await browserOf(host, o.session.id);
  if (!where) throw new Error("could not find the session's browser");
  if (!where.id.startsWith("vm-")) {
    await inContainer(where.id, KILL_BY("/opt/chrome/chrome"));
    return "killed in its container";
  }
  const b = await o.browser.newBrowserCDPSession();
  void b.send("Browser.crash").catch(() => undefined);
  const gone = await until("Chrome to crash", 15_000, async () => {
    const st = (
      await agentState(host.nodes.find((n) => n.id === where.node)!)
    ).sessions.find((s) => s.sessionId === o.session.id);
    return !st || st.state !== "ready";
  }).catch(() => false);
  if (gone) return "crashed over CDP (Browser.crash)";
  for (const p of await listProcesses(realHost)) {
    const k = classify(p);
    if (k?.id === where.id && k.kind === "vmm") process.kill(p.pid, "SIGKILL");
  }
  return "did not crash over CDP; its VMM was killed";
}

// --- check 11's cases -----------------------------------------------------------------------------

interface ChaosEnv {
  client: KestrelClient;
  c: ProfileCheckConfig;
  master: Buffer;
  base: (
    m: Marks,
  ) => Promise<{ profileId: ProfileId; version: number; partitioned: boolean }>;
  writer: (profileId: ProfileId) => Promise<Session>;
  read: (
    profileId: ProfileId,
    node: string | undefined,
    m: Marks,
  ) => Promise<{
    session: Session;
    back: Awaited<ReturnType<typeof readMarks>>;
  }>;
  written: Marks[];
}

/**
 * After a fault: the lock frees, and the profile is wholly the old version or wholly the new
 * one, in the store (the current version opens and its cookies are all one write's) and in a
 * reader.
 */
async function judgeAfterFault(
  e: ChaosEnv,
  profileId: ProfileId,
  old: Marks,
  next: Marks,
  base: { version: number; partitioned: boolean },
): Promise<string> {
  const p = await lockFree(e.client, profileId, 120_000);
  const expect = p.version === base.version ? "old" : "new";
  if (p.version < base.version)
    throw new Error(`the profile went back to version ${p.version}`);
  const row = (await versionRows(e.c.paths, [profileId])).find(
    (r) => r.version === p.version,
  );
  if (!row) throw new Error(`no row for the current version ${p.version}`);
  const v = await openVersion(e.c.paths, e.master, row);
  const stored = new Map(v.cookies.map((x) => [x.name, x.value]));
  const set = expect === "old" ? old : next;
  const cookiesOk = [
    set.sessionCookie,
    set.persistentCookie,
    set.httpOnlyCookie,
  ].every((x) => stored.get(x.name) === x.value);
  if (!cookiesOk)
    throw new Error(
      `version ${p.version}'s stored cookies are not wholly the ${expect} write's`,
    );
  const r = await e.read(profileId, undefined, old);
  const got = classifyMarks(old, next, r.back, {
    partitioned: base.partitioned,
  });
  if (got.state !== expect)
    throw new Error(
      `the profile is version ${p.version} (${expect}) but a reader found ${got.state}: ${got.detail}`,
    );
  return `lock free; version ${p.version} (${expect}), whole in the store (${v.files} files) and in a reader`;
}

const apiUp = (client: KestrelClient, ms = 120_000) =>
  until(
    "the API to answer",
    ms,
    async () => (await client.list("?limit=1"), true),
    1000,
  );

/** Every node agent of the deployment, as Compose names them. */
const agents = (c: ProfileCheckConfig) =>
  c.host.nodes.map((n) => `node-${n.id}`);

async function agentsUp(c: ProfileCheckConfig): Promise<void> {
  for (const n of c.host.nodes)
    await until(
      `agent ${n.id} to answer`,
      120_000,
      async () => (await agentState(n)).admitting,
      1000,
    );
  await sleep(5000); // registered with the API again
}

async function withNodeFailpoints<T>(
  c: ProfileCheckConfig,
  spec: string,
  fn: () => Promise<T>,
): Promise<T> {
  const vars = (s: string) =>
    Object.fromEntries(c.host.nodes.map((n) => [nodeFailpointVar(n.id), s]));
  await recreate(c.compose, agents(c), vars(spec));
  await agentsUp(c);
  try {
    return await fn();
  } finally {
    await recreate(c.compose, agents(c), vars(""));
    await agentsUp(c);
  }
}

async function withApiFailpoints<T>(
  e: ChaosEnv,
  spec: string,
  fn: () => Promise<T>,
): Promise<T> {
  await recreate(e.c.compose, ["api"], { KESTREL_FAILPOINTS: spec });
  await apiUp(e.client);
  try {
    return await fn();
  } finally {
    await recreate(e.c.compose, ["api"], { KESTREL_FAILPOINTS: "" });
    await apiUp(e.client);
  }
}

/**
 * A writer over a saved profile (its version holds `old`) writes `next`, and `fault` ends it with
 * a fault on the way; then the profile is judged.
 */
async function interrupted(
  e: ChaosEnv,
  fault: (s: Session) => Promise<string>,
  opts: { idleTimeout?: number } = {},
): Promise<string> {
  const old = newMarks();
  const next = newMarks();
  const base = await e.base(old);
  const s = opts.idleTimeout
    ? (
        await e.client.create({
          profile: { id: base.profileId, persist: true },
          idleTimeout: opts.idleTimeout,
          waitForCapacityMs: 30_000,
        })
      ).session
    : await e.writer(base.profileId);
  const o = await openOn(s, e.c.testPageUrl);
  try {
    await writeMarks(o, next);
  } finally {
    await o.browser.close().catch(() => undefined);
  }
  e.written.push(next);
  const what = await fault(s);
  const outcome = await awaitOutcome(e.client, s.id, 180_000);
  const judged = await judgeAfterFault(e, base.profileId, old, next, base);
  return `${what}; ${outcome.type === "profile.saved" ? `saved as version ${outcome.version}` : `save_failed ${outcome.reason}`}; ${judged}`;
}

const AFTER_PULL = "node.profile.after_pull";
const AFTER_SUM = "api.profile.commit.after_sum";

export const CHAOS: { id: string; run: (e: ChaosEnv) => Promise<string> }[] = [
  {
    id: "agent-restart-during-save",
    // The save stalls once its archive is pulled (the browser still up); the agent is restarted
    // then. At boot it tears the session down again and asks the browser for the save once more.
    // A `:once` failpoint leaves the agent's list when it fires: that is the moment it stalls.
    run: (e) =>
      withNodeFailpoints(e.c, `${AFTER_PULL}=stall:15000:once`, () =>
        interrupted(e, async (s) => {
          await e.client.stop(s.id);
          const node = s.nodeId!;
          const n = e.c.host.nodes.find((x) => x.id === node)!;
          await until(
            "the save to stall after its pull",
            30_000,
            async () => !(AFTER_PULL in (await agentState(n)).failpoints),
            100,
          );
          await sh("docker", ["restart", `kestrel-node-${node}-1`]);
          return `agent ${node} restarted while its save was pulled and stalled`;
        }),
      ),
  },
  {
    id: "agent-crash-after-write",
    // The agent dies once the blob is written and before the report is queued; at boot it finds the
    // written save and reports it.
    run: (e) =>
      withNodeFailpoints(e.c, "node.profile.after_write=exit:once", () =>
        interrupted(e, async (s) => {
          await e.client.stop(s.id);
          return `agent ${s.nodeId} died after writing the blob (restarted by Docker)`;
        }),
      ),
  },
  {
    id: "api-restart-during-commit",
    // The commit stalls inside its transaction (the project's bytes summed, nothing committed); the
    // API is restarted then, and the node sends the report again.
    run: (e) =>
      withApiFailpoints(e, `${AFTER_SUM}=stall:15000:once`, () =>
        interrupted(e, async (s) => {
          await e.client.stop(s.id);
          await until(
            "the commit to stall",
            60_000,
            async () => {
              const h = (await (
                await fetch(`${e.c.host.apiInternal}/healthz`, {
                  signal: AbortSignal.timeout(4000),
                })
              ).json()) as { failpoints?: Record<string, string> };
              return h.failpoints !== undefined && !(AFTER_SUM in h.failpoints);
            },
            100,
          );
          await sh("docker", ["restart", "kestrel-api-1"]);
          await apiUp(e.client);
          return `API restarted while the commit of ${s.id} was stalled`;
        }),
      ),
  },
  {
    id: "postgres-down-across-save",
    // The writer ends at its idle timeout, which its agent enforces with no API: Postgres is
    // stopped before and started 20 s later, so the save and its report happen while it is down.
    run: (e) =>
      interrupted(
        e,
        async () => {
          const compose = composeArgs(e.c.compose);
          await sh("docker", [...compose, "stop", "postgres"]);
          try {
            await sleep(20_000);
          } finally {
            await sh("docker", [...compose, "start", "postgres"]);
          }
          await apiUp(e.client);
          return "Postgres stopped for 20 s across the writer's idle timeout and save";
        },
        { idleTimeout: 15_000 },
      ),
  },
];

export function profileCheckConfigFromEnv(
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): ProfileCheckConfig {
  const base = m1ConfigFromEnv(env, log);
  const quick = env.QUICK === "1";
  return {
    apiUrl: base.apiUrl,
    apiKey: base.apiKey,
    testPageUrl: base.testPageUrl,
    host: base.host,
    environment: {
      ...base.environment,
      microvmProfiles: env.MICROVM_PROFILES ?? "vm",
    },
    ...(env.ONLY ? { only: env.ONLY.split(",").map(Number) } : {}),
    ...(env.PROFILE_CHAOS_CASES
      ? { chaosOnly: env.PROFILE_CHAOS_CASES.split(",") }
      : {}),
    log,
    latencySamples: Number(env.PROFILE_LATENCY_SAMPLES ?? (quick ? 10 : 50)),
    latencyProfileMib: Number(env.PROFILE_LATENCY_MIB ?? 5),
    tooLargeMib: Number(env.PROFILE_TOO_LARGE_MIB ?? 80),
    paths: {
      databaseUrlFile: base.host.databaseUrlFile,
      masterKeyFile:
        env.PROFILE_MASTER_KEY_FILE ?? "/secrets/profile-master.key",
      storeDir: base.host.profileStoreDir ?? "/var/lib/kestrel/profiles",
    },
    compose: {
      runtimeA: env.RUNTIME_A ?? "docker",
      twoNodes: env.TWO_NODES === "1",
    },
    otherProject: env.PROFILE_OTHER_PROJECT ?? "bench-profiles-b",
  };
}
