import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  idToUuid,
  maxProfileArchiveBytes,
  parseProfileArchive,
  PROFILE_LIMITS,
  type ProfileCookies,
} from "@kestrel/contracts";
import { createPrisma } from "@kestrel/db";
import {
  deriveProjectKey,
  openProfileBlob,
  profileBlobKey,
  unwrapDataKey,
} from "@kestrel/shared";

/**
 * P18 (docs/lld/p18-profiles.md section 10): what `bench profiles` reads and does on the host
 * itself, from inside the platform image (`infra/host/bench.sh`): the profile rows, the master key
 * (to unwrap this run's data keys, so check 7 can look for them where they must never be, and so
 * check 11 can open a version and see it is whole), the store's files, Postgres, the node agents'
 * stores and the platform's logs, and the Compose services a chaos case restarts.
 */

/** Run a command; its output and error output together, unless `stdoutOnly`. */
export const run = (
  cmd: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    stdoutOnly?: boolean;
  } = {},
): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    execFile(
      cmd,
      args,
      {
        encoding: "buffer",
        maxBuffer: 512 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 120_000,
        env: { ...process.env, ...opts.env },
      },
      (e, stdout, stderr) =>
        e
          ? reject(
              new Error(
                `${cmd} ${args.slice(0, 3).join(" ")}: ${stderr.toString().slice(0, 300) || e.message}`,
              ),
            )
          : resolve(opts.stdoutOnly ? stdout : Buffer.concat([stdout, stderr])),
    ),
  );

// --- versions, keys and blobs -------------------------------------------------------------------

export interface VersionRow {
  profileId: string;
  projectUuid: string;
  profileUuid: string;
  version: number;
  state: string;
  wrappedKey: Buffer;
  bytes: number | null;
  sha256: string | null;
}

export interface HostPaths {
  databaseUrlFile: string;
  /** The API's master key (root can read it; the harness runs as root). */
  masterKeyFile: string;
  /** The profile store, mounted read-only. */
  storeDir: string;
}

/** Every version row of these profiles (deleted ones included, while their rows last). */
export async function versionRows(
  p: HostPaths,
  profileIds: string[],
): Promise<VersionRow[]> {
  if (profileIds.length === 0) return [];
  const byUuid = new Map(profileIds.map((id) => [idToUuid(id), id]));
  const db = createPrisma(readFileSync(p.databaseUrlFile, "utf8").trim(), {
    max: 1,
  });
  try {
    const rows = await db.profileVersion.findMany({
      where: { profileId: { in: [...byUuid.keys()] } },
      select: {
        profileId: true,
        version: true,
        state: true,
        wrappedKey: true,
        bytes: true,
        sha256: true,
        profile: { select: { projectId: true } },
      },
      orderBy: [{ profileId: "asc" }, { version: "asc" }],
    });
    return rows.map((r) => ({
      profileId: byUuid.get(r.profileId)!,
      projectUuid: r.profile.projectId,
      profileUuid: r.profileId,
      version: r.version,
      state: r.state,
      wrappedKey: Buffer.from(r.wrappedKey),
      bytes: r.bytes === null ? null : Number(r.bytes),
      sha256: r.sha256,
    }));
  } finally {
    await db.$disconnect();
  }
}

/** A version's data key, unwrapped with the project's key as the API does. */
export function dataKey(master: Buffer, row: VersionRow): Buffer {
  return unwrapDataKey(
    deriveProjectKey(master, row.projectUuid),
    row.wrappedKey,
    row.profileUuid,
    row.version,
  );
}

/**
 * Open a committed version from the store and parse it: its length and digest must be the row's,
 * its tag must verify, and the archive must pass the same checks a node applies. A torn or
 * substituted version fails here.
 */
export async function openVersion(
  p: HostPaths,
  master: Buffer,
  row: VersionRow,
): Promise<{ cookies: ProfileCookies; files: number; bytes: number }> {
  const key = profileBlobKey(row.projectUuid, row.profileUuid, row.version);
  const blob = await readFile(join(p.storeDir, key));
  if (row.bytes !== null && blob.length !== row.bytes)
    throw new Error(
      `version ${row.version} is ${blob.length} bytes in the store, ${row.bytes} in its row`,
    );
  const digest = createHash("sha256").update(blob).digest("hex");
  if (row.sha256 !== null && digest !== row.sha256)
    throw new Error(`version ${row.version}'s digest is not its row's`);
  const archive = await openProfileBlob(
    dataKey(master, row),
    {
      projectUuid: row.projectUuid,
      profileUuid: row.profileUuid,
      version: row.version,
    },
    blob,
    maxProfileArchiveBytes(PROFILE_LIMITS.maxBytesCeiling),
  );
  const parsed = parseProfileArchive(archive, PROFILE_LIMITS.maxBytesCeiling);
  return {
    cookies: parsed.cookies,
    files: parsed.files.length,
    bytes: blob.length,
  };
}

// --- looking for secrets where they must not be (check 7, T-72, T-73) ---------------------------

export interface Needle {
  label: string;
  /** Every spelling it could be stored in. */
  forms: Buffer[];
}

/** A value a page wrote: as UTF-8 and as UTF-16 (how SQLite and Chrome may keep text). */
export function textNeedle(label: string, s: string): Needle {
  return {
    label,
    forms: [Buffer.from(s, "utf8"), Buffer.from(s, "utf16le")],
  };
}

/** A key: raw, hex (either case), base64 and base64url, as a log, a row or a store could hold it. */
export function keyNeedle(label: string, key: Buffer): Needle {
  const hex = key.toString("hex");
  return {
    label,
    forms: [
      key,
      Buffer.from(hex),
      Buffer.from(hex.toUpperCase()),
      Buffer.from(key.toString("base64").replace(/=+$/, "")),
      Buffer.from(key.toString("base64url")),
    ],
  };
}

export function findNeedles(
  needles: Needle[],
  haystacks: { where: string; data: Buffer }[],
): { where: string; label: string }[] {
  const found: { where: string; label: string }[] = [];
  for (const h of haystacks)
    for (const n of needles)
      if (n.forms.some((f) => f.length > 0 && h.data.includes(f)))
        found.push({ where: h.where, label: n.label });
  return found;
}

/** Every file under the store, raw. */
export async function storeFiles(
  dir: string,
): Promise<{ where: string; data: Buffer }[]> {
  const out: { where: string; data: Buffer }[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else if ((await lstat(p)).isFile())
        out.push({ where: `store ${r}`, data: await readFile(p) });
    }
  };
  await walk(dir, "");
  return out;
}

/** Postgres, every table's rows as text (bytea in hex), through the database's own container. */
export async function postgresDump(): Promise<{ where: string; data: Buffer }> {
  return {
    where: "postgres",
    data: await run("docker", [
      "exec",
      "kestrel-postgres-1",
      "pg_dump",
      "-U",
      "kestrel",
      "-d",
      "kestrel",
      "--data-only",
    ]),
  };
}

/** A node agent's SQLite store, raw, with its journal and WAL (a deleted row's bytes linger there). */
export async function agentStore(
  node: string,
): Promise<{ where: string; data: Buffer }> {
  const dir = `/var/lib/kestrel/${node}`;
  return {
    where: `node ${node} store`,
    data: await run("docker", [
      "exec",
      `kestrel-node-${node}-1`,
      "node",
      "-e",
      `const fs = require("fs"); for (const f of ["store.db", "store.db-wal", "store.db-journal", "store.db-shm"]) { try { process.stdout.write(fs.readFileSync(${JSON.stringify(dir)} + "/" + f)); } catch {} }`,
    ]),
  };
}

/** The platform's own containers' logs (the browsers' containers are gone with their sessions). */
export async function platformLogs(): Promise<
  { where: string; data: Buffer }[]
> {
  const names = (await run("docker", ["ps", "-a", "--format", "{{.Names}}"]))
    .toString()
    .split("\n")
    .filter((n) =>
      /^kestrel-(api|web|postgres|egress-[a-z]|node-[a-z]|gateway-[a-z])-\d+$/.test(
        n,
      ),
    );
  const out: { where: string; data: Buffer }[] = [];
  for (const n of names)
    out.push({ where: `${n} logs`, data: await run("docker", ["logs", n]) });
  return out;
}

// --- Compose: restarting a service with failpoints (check 11) -----------------------------------

/** `docker compose` for this deployment, as `infra/host/bench.sh` and `deploy.sh` compose it. */
export function composeArgs(c: {
  runtimeA: string;
  twoNodes: boolean;
}): string[] {
  return [
    "compose",
    "-p",
    "kestrel",
    "--env-file",
    "/var/lib/kestrel/compose.env",
    "-f",
    "/srv/kestrel/infra/compose/docker-compose.yml",
    ...(c.runtimeA === "microvm"
      ? ["-f", "/srv/kestrel/infra/compose/docker-compose.microvm.yml"]
      : []),
    ...(c.twoNodes ? ["--profile", "b"] : []),
  ];
}

/** The variable that carries a node agent's failpoints (`docker-compose.yml`). */
export const nodeFailpointVar = (node: string): string =>
  node === "a"
    ? "KESTREL_FAILPOINTS_NODE"
    : `KESTREL_FAILPOINTS_NODE_${node.toUpperCase()}`;

/** Recreate services with these variables (failpoints on, or off again), nothing else. */
export async function recreate(
  c: { runtimeA: string; twoNodes: boolean },
  services: string[],
  vars: Record<string, string>,
): Promise<void> {
  await run(
    "docker",
    [
      ...composeArgs(c),
      "up",
      "-d",
      "--no-deps",
      "--force-recreate",
      ...services,
    ],
    { env: vars, timeoutMs: 180_000 },
  );
}

// --- a second project (check 7) -----------------------------------------------------------------

const ADMIN = fileURLToPath(
  new URL("../../../apps/api/dist/admin.js", import.meta.url),
);

/** A key for another project, made with the API's admin command; revoke it when done. */
export async function otherProjectKey(
  databaseUrlFile: string,
  project: string,
): Promise<{ key: string; revoke: () => Promise<void> }> {
  const env = { DATABASE_URL_FILE: databaseUrlFile };
  await run("node", [ADMIN, "bootstrap", "--project", project], { env });
  const out = (
    await run(
      "node",
      [ADMIN, "create-key", "--project", project, "--name", "bench-profiles"],
      { env, stdoutOnly: true },
    )
  )
    .toString()
    .trim()
    .split("\n");
  const id = /Key (\S+) for project/.exec(out.join("\n"))?.[1];
  const key = out.at(-1)?.trim() ?? "";
  if (!id || !key.startsWith("ksl_"))
    throw new Error("the admin command did not print a key");
  return {
    key,
    revoke: async () => {
      await run("node", [ADMIN, "revoke-key", id], { env });
    },
  };
}
