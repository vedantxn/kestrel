import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { encodeProfileArchive } from "@kestrel/contracts";
import {
  deriveProjectKey,
  FsProfileStore,
  newDataKey,
  profileBlobKey,
  sealProfileBlob,
  wrapDataKey,
} from "@kestrel/shared";
import { describe, expect, it } from "vitest";
import {
  composeArgs,
  dataKey,
  findNeedles,
  keyNeedle,
  nodeFailpointVar,
  openVersion,
  storeFiles,
  textNeedle,
  type VersionRow,
} from "./profile-host.js";

const PROJECT = "0192aaaa-0000-7000-8000-000000000001";
const PROFILE = "0192bbbb-0000-7000-8000-000000000002";

/** A committed version in a store, as the API and a node would leave it. */
async function committed(version = 1) {
  const dir = mkdtempSync(join(tmpdir(), "kpf-bench-"));
  const master = randomBytes(32);
  const key = newDataKey();
  const archive = encodeProfileArchive(
    [
      {
        name: "kb_session",
        value: "kb-old",
        domain: "example.com",
        path: "/",
        secure: true,
        httpOnly: false,
      },
    ],
    [{ path: "Default/LocalStorage", data: Buffer.from("local") }],
  );
  const ids = { projectUuid: PROJECT, profileUuid: PROFILE, version };
  const blob = await sealProfileBlob(key, ids, archive);
  await new FsProfileStore(dir).put(
    profileBlobKey(PROJECT, PROFILE, version),
    blob,
  );
  const row: VersionRow = {
    profileId: "prf_x",
    projectUuid: PROJECT,
    profileUuid: PROFILE,
    version,
    state: "committed",
    wrappedKey: wrapDataKey(
      deriveProjectKey(master, PROJECT),
      key,
      PROFILE,
      version,
    ),
    bytes: blob.length,
    sha256: createHash("sha256").update(blob).digest("hex"),
  };
  const paths = { databaseUrlFile: "", masterKeyFile: "", storeDir: dir };
  return { dir, master, key, row, paths, blob };
}

describe("opening a version from the host (P18 checks 7 and 11)", () => {
  it("unwraps the data key as the API does, and opens and parses the version", async () => {
    const c = await committed();
    expect(dataKey(c.master, c.row).equals(c.key)).toBe(true);
    const v = await openVersion(c.paths, c.master, c.row);
    expect(v.cookies.map((x) => `${x.name}=${x.value}`)).toEqual([
      "kb_session=kb-old",
    ]);
    expect(v.files).toBe(1);
  });

  it("refuses a version whose length, digest or bytes are not its row's", async () => {
    const c = await committed();
    await expect(
      openVersion(c.paths, c.master, { ...c.row, bytes: c.row.bytes! + 1 }),
    ).rejects.toThrow(/bytes/);
    await expect(
      openVersion(c.paths, c.master, { ...c.row, sha256: "0".repeat(64) }),
    ).rejects.toThrow(/digest/);
    const torn = Buffer.from(c.blob);
    torn[100] = torn[100]! ^ 1;
    writeFileSync(join(c.dir, profileBlobKey(PROJECT, PROFILE, 1)), torn);
    await expect(
      openVersion(c.paths, c.master, { ...c.row, sha256: null }),
    ).rejects.toThrow(/decrypt/);
    // Another project's master key opens nothing.
    await expect(
      openVersion(c.paths, randomBytes(32), c.row),
    ).rejects.toThrow();
  });
});

describe("looking for this run's secrets where they must not be (check 7)", () => {
  it("finds a key in any spelling and a page's value as UTF-8 or UTF-16, and names where", () => {
    const key = randomBytes(32);
    const needles = [
      keyNeedle("data key v1", key),
      textNeedle("cookie value", "kb0123456789abcdef"),
    ];
    const hay = (where: string, data: Buffer | string) => ({
      where,
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
    });
    expect(
      findNeedles(needles, [
        hay("clean log", "nothing here\n"),
        hay("raw", Buffer.concat([Buffer.from("x"), key, Buffer.from("y")])),
        hay("hex", `key=${key.toString("hex").toUpperCase()}`),
        hay("base64", JSON.stringify({ k: key.toString("base64") })),
        hay("base64url", key.toString("base64url")),
        hay("utf16", Buffer.from("..kb0123456789abcdef..", "utf16le")),
        hay("utf8", "Cookie: kb_session=kb0123456789abcdef"),
      ]),
    ).toEqual([
      { where: "raw", label: "data key v1" },
      { where: "hex", label: "data key v1" },
      { where: "base64", label: "data key v1" },
      { where: "base64url", label: "data key v1" },
      { where: "utf16", label: "cookie value" },
      { where: "utf8", label: "cookie value" },
    ]);
  });

  it("reads every file of the store, raw", async () => {
    const c = await committed();
    const files = await storeFiles(c.dir);
    expect(files.map((f) => f.where)).toEqual([
      `store ${profileBlobKey(PROJECT, PROFILE, 1)}`,
    ]);
    // The store holds ciphertext only: neither the value nor the key is in it.
    expect(
      findNeedles(
        [textNeedle("cookie", "kb-old"), keyNeedle("key", c.key)],
        files,
      ),
    ).toEqual([]);
  });
});

describe("restarting services for the chaos cases (check 11)", () => {
  it("composes the deployment as deploy.sh does, the microVM overlay and node b included", () => {
    expect(composeArgs({ runtimeA: "docker", twoNodes: false })).toEqual([
      "compose",
      "-p",
      "kestrel",
      "--env-file",
      "/var/lib/kestrel/compose.env",
      "-f",
      "/srv/kestrel/infra/compose/docker-compose.yml",
    ]);
    expect(composeArgs({ runtimeA: "microvm", twoNodes: true })).toEqual([
      "compose",
      "-p",
      "kestrel",
      "--env-file",
      "/var/lib/kestrel/compose.env",
      "-f",
      "/srv/kestrel/infra/compose/docker-compose.yml",
      "-f",
      "/srv/kestrel/infra/compose/docker-compose.microvm.yml",
      "--profile",
      "b",
    ]);
  });

  it("names each node's failpoint variable as docker-compose.yml does", () => {
    expect(nodeFailpointVar("a")).toBe("KESTREL_FAILPOINTS_NODE");
    expect(nodeFailpointVar("b")).toBe("KESTREL_FAILPOINTS_NODE_B");
  });
});
