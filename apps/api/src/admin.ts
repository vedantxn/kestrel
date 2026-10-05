import { readFileSync as readSecretFile } from "node:fs";

// Secrets are files, not environment variables (threat model G-09): DATABASE_URL_FILE names the file holding the URL.
if (!process.env.DATABASE_URL && process.env.DATABASE_URL_FILE)
  process.env.DATABASE_URL = readSecretFile(
    process.env.DATABASE_URL_FILE,
    "utf8",
  ).trim();
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPrisma } from "@kestrel/db";
import { generateTokenKeys } from "@kestrel/shared";
import { createApiKey } from "./auth.js";
import { newUuid } from "./ids.js";

/**
 * Admin commands, run on the host (A9). The dashboard (P17) signs in with a key made here.
 *
 *   admin bootstrap                       create the organisation and project if absent
 *   admin create-key [--project NAME] [--name LABEL] [--admin]   print a new key, once;
 *                                         --admin lets it call /v1/admin/* (threat model T-57)
 *   admin revoke-key KEY_ID_OR_PREFIX     stop a key authenticating at once (threat model G-02)
 *   admin list-keys
 *   admin keygen --dir DIR                make the token signing keypair
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: "string" },
    name: { type: "string" },
    dir: { type: "string" },
    admin: { type: "boolean" },
  },
});
const [command, arg] = positionals;

if (command === "keygen") {
  const dir = values.dir;
  if (!dir) throw new Error("keygen needs --dir");
  mkdirSync(dir, { recursive: true });
  const { privatePem, publicPem } = await generateTokenKeys();
  writeFileSync(join(dir, "token-private.pem"), privatePem, { mode: 0o600 });
  chmodSync(join(dir, "token-private.pem"), 0o600);
  writeFileSync(join(dir, "token-public.pem"), publicPem, { mode: 0o644 });
  console.log(
    `wrote ${join(dir, "token-private.pem")} (0600) and ${join(dir, "token-public.pem")}`,
  );
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createPrisma(url, { max: 2 });
const projectName = values.project ?? "default";

try {
  if (command === "bootstrap") {
    const org =
      (await db.org.findFirst()) ??
      (await db.org.create({ data: { id: newUuid(), name: "default" } }));
    const project =
      (await db.project.findFirst({
        where: { orgId: org.id, name: projectName },
      })) ??
      (await db.project.create({
        data: { id: newUuid(), orgId: org.id, name: projectName },
      }));
    console.log(
      JSON.stringify({
        orgId: org.id,
        projectId: project.id,
        project: project.name,
      }),
    );
  } else if (command === "create-key") {
    const project = await db.project.findFirst({
      where: { name: projectName },
    });
    if (!project)
      throw new Error(`no project "${projectName}"; run bootstrap first`);
    const { key, id } = await createApiKey(
      db,
      project.id,
      values.name ?? "cli",
      new Date(),
      { admin: values.admin ?? false },
    );
    console.log(
      `${values.admin ? "Admin key" : "Key"} ${id} for project "${project.name}". It is shown once and cannot be recovered:\n${key}`,
    );
  } else if (command === "revoke-key") {
    if (!arg) throw new Error("revoke-key needs a key id or prefix");
    const keys = await db.apiKey.findMany({
      where: { revokedAt: null, OR: [{ id: arg }, { prefix: arg }] },
    });
    if (keys.length !== 1)
      throw new Error(
        `expected exactly one active key matching "${arg}", found ${keys.length}`,
      );
    await db.apiKey.update({
      where: { id: keys[0]!.id },
      data: { revokedAt: new Date() },
    });
    console.log(`revoked ${keys[0]!.id} (${keys[0]!.prefix}...)`);
  } else if (command === "list-keys") {
    for (const k of await db.apiKey.findMany({
      orderBy: { createdAt: "asc" },
    })) {
      console.log(
        `${k.id}  ${k.prefix}...  ${k.name}  ${k.revokedAt ? "REVOKED" : "active"}${k.admin ? "  ADMIN" : ""}  last used ${k.lastUsedAt?.toISOString() ?? "never"}`,
      );
    }
  } else {
    console.error(
      "usage: admin <bootstrap|create-key|revoke-key|list-keys|keygen> [options]",
    );
    process.exitCode = 2;
  }
} finally {
  await db.$disconnect();
}
