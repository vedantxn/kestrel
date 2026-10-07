import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProfileArchive, type ProfileId } from "@kestrel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildPublicApp } from "../apps/api/src/http.js";
import { makeEnv, type Env } from "../apps/api/src/test/harness.js";
import { ApiError, KestrelClient } from "../bench/framework/src/client.js";
import {
  awaitOutcome,
  crossProjectRefused,
  lockFree,
  singleWriter,
} from "../bench/framework/src/profile-check.js";
import {
  dataKey,
  openVersion,
  versionRows,
} from "../bench/framework/src/profile-host.js";

/*
 * `bench profiles` (P18-11) against the real API over HTTP, with a fake node that saves as the
 * agent does: the parts of the host checks that need only the API and the database.
 */
describe("bench profiles' API checks, against the real API", () => {
  let env: Env;
  let pump: NodeJS.Timeout | undefined;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    clearInterval(pump);
    await close?.();
    await env?.close();
  });

  async function setup() {
    env = await makeEnv({ profiles: true, nodes: [{ id: "a", slots: 30 }] });
    const app = buildPublicApp(env.ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    close = () => app.close();
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // The fake node sends its reports (removals, saves) in the background, as an agent does.
    pump = setInterval(
      () => void env.nodes.a!.sync(env.internal).catch(() => undefined),
      20,
    );
    return {
      client: new KestrelClient(url, env.key, 10_000),
      other: new KestrelClient(url, env.project2.key, 10_000),
    };
  }

  it("check 4: one writer of ten starts, nine get 409 on profile.id, readers start, and the next writer follows within a second", async () => {
    const { client } = await setup();
    const p = await client.createProfile();
    const r = await singleWriter(client, p.id, {
      writers: 10,
      readers: 5,
      withinMs: 1000,
    });
    expect(r.detail).toContain("1 of 10 writers started");
    expect(r.pass).toBe(true);
    expect(r.releaseMs).toBeLessThan(1000);
    expect((await lockFree(client, p.id)).inUseBy).toBeNull();
  });

  it("a writer's outcome comes from its events, saved or failed, and the lock frees", async () => {
    const { client } = await setup();
    const p = await client.createProfile();
    const w = await client.create({ profile: { id: p.id, persist: true } });
    await client.stop(w.session.id);
    expect(await awaitOutcome(client, w.session.id, 10_000)).toMatchObject({
      type: "profile.saved",
      version: 1,
    });
    expect(await lockFree(client, p.id, 10_000)).toMatchObject({
      version: 1,
      inUseBy: null,
    });
    env.nodes.a!.profileSave = "too_large";
    const big = await client.create({ profile: { id: p.id, persist: true } });
    await client.stop(big.session.id);
    expect(await awaitOutcome(client, big.session.id, 10_000)).toEqual({
      type: "profile.save_failed",
      reason: "too_large",
    });
    expect((await lockFree(client, p.id, 10_000)).version).toBe(1);
  });

  it("check 7: another project is told the profile does not exist, whatever it asks", async () => {
    const { client, other } = await setup();
    const p = await client.createProfile();
    expect(await crossProjectRefused(other, p.id)).toEqual([]);
    // The profile is untouched by the other project's delete.
    expect((await client.getProfile(p.id)).id).toBe(p.id);
    // Asked with the owner's own key, every call succeeds, and each is named.
    const own = await crossProjectRefused(client, p.id);
    expect(own).toEqual([
      "a reader succeeded",
      "a writer succeeded",
      "a get succeeded",
      "a delete succeeded",
    ]);
    await expect(client.getProfile(p.id)).rejects.toBeInstanceOf(ApiError);
  });

  it("checks 7 and 11: reads this run's version rows, unwraps their keys, and opens the current version", async () => {
    const { client } = await setup();
    const archive = encodeProfileArchive(
      [
        {
          name: "kb_session",
          value: "kb-new",
          domain: "example.com",
          path: "/",
          secure: true,
          httpOnly: false,
        },
      ],
      [{ path: "Default/LocalStorage", data: Buffer.from("local") }],
    );
    env.nodes.a!.profileArchive = archive;
    const p = await client.createProfile();
    const w = await client.create({ profile: { id: p.id, persist: true } });
    await client.stop(w.session.id);
    await awaitOutcome(client, w.session.id, 10_000);
    await lockFree(client, p.id, 10_000);

    const urlFile = join(mkdtempSync(join(tmpdir(), "bench-db-")), "url");
    writeFileSync(urlFile, process.env.DATABASE_URL as string);
    const cfg = env.ctx.profiles!;
    const paths = {
      databaseUrlFile: urlFile,
      masterKeyFile: "",
      storeDir: (cfg.store as unknown as { root: string }).root,
    };
    const rows = await versionRows(paths, [p.id as ProfileId]);
    expect(rows.map((r) => [r.profileId, r.version, r.state])).toEqual([
      [p.id, 1, "committed"],
    ]);
    expect(dataKey(cfg.master, rows[0]!)).toHaveLength(32);
    const v = await openVersion(paths, cfg.master, rows[0]!);
    expect(v.cookies.map((c) => c.value)).toEqual(["kb-new"]);
    expect(v.files).toBe(1);
  });
});
