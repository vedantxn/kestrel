import { readFileSync, statSync, truncateSync, appendFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  RECORDING_FILE,
  RECORDING_FRAGMENTS_HEADER,
  RECORDING_LIMITS,
} from "@kestrel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { invalid } from "./recording-pull.js";
import { HttpRuntimeClient, RuntimeHttpError } from "./runtime-client.js";
import type { FakeGuestRecording } from "./test/fakes.js";
import {
  bootWithPool,
  makeRig,
  mp4Box,
  startReq,
  type Rig,
} from "./test/fakes.js";

/** A microVM node: recordings are pulled out of the guest (docs/lld/microvm-recording.md). */
const vmRig = (over: Parameters<typeof makeRig>[0] = {}) =>
  makeRig(
    { recordingSink: "pull", recordingStopMs: 2000, ...over },
    { volumes: true },
  );

async function recording(r: Rig) {
  const req = startReq({ recording: true });
  const res = await r.agent.start(req);
  const b = r.store.getBinding(req.sessionId)!;
  const guest = r.runtime.guests.get(b.address!)!;
  const volume = r.store.getRecording(req.sessionId)!.volume;
  const file = join(r.volumes!.root, volume, RECORDING_FILE);
  return { req, res, b, guest, volume, file };
}

const pull = async (r: Rig) => {
  r.agent.pullRecordings();
  await r.agent.idle();
};
const stop = async (r: Rig, sessionId: string) => {
  await r.agent.stop({ sessionId, reason: "client_stop" } as never);
  await r.agent.idle();
};
const ops = (r: Rig) => r.runtime.calls.map((c) => c.op);

describe("recording in a microVM: the agent pulls fragments (W3)", () => {
  it("needs no volume on any browser: a recording session takes a hot VM and is told to keep fragments for the agent", async () => {
    const r = vmRig({ poolTarget: 2, recordingPool: 1 });
    await bootWithPool(r);
    expect(r.volumes!.vols.size).toBe(0);
    expect(
      [...r.docker.specs.values()].every((s) => !s.HostConfig?.Mounts),
    ).toBe(true);
    const { req, res, b, volume } = await recording(r);
    expect(res).toMatchObject({ result: "ready", startPath: "hot" });
    expect(r.runtime.configured.get(b.address!)).toMatchObject({
      recording: true,
      recordingSink: "pull",
    });
    expect(r.volumes!.vols.has(volume)).toBe(true);
    expect(r.store.getPull(req.sessionId)).toEqual({
      seq: 0,
      bytes: 0,
      done: false,
    });
    // A session that does not record has no volume and nothing to pull.
    const plain = startReq();
    await r.agent.start(plain);
    expect(r.store.getRecording(plain.sessionId)).toBeUndefined();
    expect(r.store.getPull(plain.sessionId)).toBeUndefined();
    expect(
      r.runtime.configured.get(r.store.getBinding(plain.sessionId)!.address!),
    ).toMatchObject({ recording: false });
  });

  it("appends what the guest has made, which is served while the session runs, and acknowledges it", async () => {
    const r = vmRig();
    await r.agent.boot();
    const { req, guest, file } = await recording(r);
    await pull(r);
    expect(await r.agent.openRecording(req.sessionId)).toBeNull(); // nothing yet
    guest.init().media(2);
    await pull(r);
    const first = Buffer.concat(guest.made);
    expect(readFileSync(file)).toEqual(first);
    const open = await r.agent.openRecording(req.sessionId);
    expect(open?.size).toBe(first.length);
    await open?.fd.close();
    expect(r.store.getPull(req.sessionId)).toMatchObject({
      seq: 3,
      bytes: first.length,
    });
    guest.media(1, 500);
    await pull(r);
    expect(readFileSync(file)).toEqual(Buffer.concat(guest.made));
    // Asking for what follows acknowledges everything: the guest may free all it made.
    expect(guest.acked).toBe(4);
    expect(ops(r)).toContain("fragments:3");
  });

  it("at the end pulls what waits, stops the recorder, pulls its last fragment, then removes the VM; the recording outlives it", async () => {
    const r = vmRig();
    await r.agent.boot();
    const { req, b, guest, volume, file } = await recording(r);
    guest.init().media(3);
    guest.onStop = [
      Buffer.concat([mp4Box("moof", 100), mp4Box("mdat", 300, 9)]),
      mp4Box("mfra", 40),
    ];
    await stop(r, req.sessionId);
    const seq = ops(r).filter(
      (o) => o.startsWith("fragments") || o === "stopRecording",
    );
    expect(seq.indexOf("stopRecording")).toBeGreaterThan(0);
    expect(seq.slice(0, seq.indexOf("stopRecording"))).toContain("fragments:0");
    expect(seq.at(-1)).toMatch(/^fragments:/);
    expect(r.docker.removed).toContain(b.containerId);
    expect(readFileSync(file)).toEqual(Buffer.concat(guest.made));
    expect(r.store.getPull(req.sessionId)?.done).toBe(true);
    expect(r.volumes!.vols.has(volume)).toBe(true);
    const rec = await r.agent.openRecording(req.sessionId);
    expect(rec?.size).toBe(Buffer.concat(guest.made).length);
    await rec?.fd.close();
  });

  it("keeps what it pulled when the VM died before the end, without waiting on it", async () => {
    const r = vmRig({ recordingStopMs: 60_000 });
    await r.agent.boot();
    const { req, b, guest, file } = await recording(r);
    guest.init().media(1);
    await pull(r);
    const had = readFileSync(file);
    guest.media(2);
    r.docker.kill(b.containerId!);
    const t0 = performance.now();
    await r.agent.reconcile();
    await r.agent.idle();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(ops(r)).not.toContain("stopRecording");
    expect(readFileSync(file)).toEqual(had);
    expect(r.store.getPull(req.sessionId)?.done).toBe(true);
  });

  it("bounds a teardown by its budget when the guest never says it is done", async () => {
    const r = vmRig({ recordingStopMs: 300 });
    await r.agent.boot();
    const { req, guest, b } = await recording(r);
    guest.init();
    guest.stop = () => undefined; // a hostile recorder that never finishes
    const t0 = performance.now();
    await stop(r, req.sessionId);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(r.docker.removed).toContain(b.containerId);
    expect(r.store.getPull(req.sessionId)?.done).toBe(true);
  });

  it("stops pulling a guest that sends what the recorder never would, keeping what came before", async () => {
    const cases: [string, (g: FakeGuestRecording) => void][] = [
      [
        "a gap in the sequence",
        (g) =>
          (g.tamper = (a) => ({
            ...a,
            meta: {
              ...a.meta,
              fragments: a.meta.fragments.map((f) => ({
                ...f,
                seq: f.seq + 1,
              })),
            },
          })),
      ],
      [
        "a box the recorder does not write",
        (g) => g.made.push(mp4Box("evil", 8)),
      ],
      ["a second ftyp", (g) => g.made.push(mp4Box("ftyp", 8))],
      [
        "sizes that do not add up to the body",
        (g) =>
          (g.tamper = (a) => ({
            ...a,
            body: Buffer.concat([a.body, Buffer.from("x")]),
          })),
      ],
    ];
    for (const [name, spoil] of cases) {
      const r = vmRig();
      await r.agent.boot();
      const { req, guest, file } = await recording(r);
      guest.init().media(1);
      await pull(r);
      const good = readFileSync(file);
      guest.media(1);
      spoil(guest);
      await pull(r);
      expect(readFileSync(file), name).toEqual(good);
      expect(r.store.getPull(req.sessionId)?.done, name).toBe(true);
      const calls = ops(r).length;
      await pull(r); // never asked again
      expect(ops(r).length, name).toBe(calls);
    }
  });

  it("refuses a first fragment that is not the start of an MP4", async () => {
    const r = vmRig();
    await r.agent.boot();
    const { req, guest, file } = await recording(r);
    guest.media(1);
    await pull(r);
    expect(() => statSync(file)).toThrow();
    expect(r.store.getPull(req.sessionId)?.done).toBe(true);
  });

  it("stops at the volume's size limit", async () => {
    const r = vmRig();
    await r.agent.boot();
    const { req, guest, file } = await recording(r);
    guest.init();
    await pull(r);
    const init = statSync(file).size;
    // A recording already at the limit (sparse), as if minutes of video had come before.
    const near = RECORDING_LIMITS.volumeBytes - 100;
    truncateSync(file, near);
    expect(
      r.store.advancePull(
        req.sessionId,
        { seq: 1, bytes: init },
        { seq: 1, bytes: near },
      ),
    ).toBe(true);
    guest.media(1);
    await pull(r);
    expect(statSync(file).size).toBe(near);
    expect(r.store.getPull(req.sessionId)?.done).toBe(true);
  });

  it("after a crash between writing and recording the cursor, rewrites those bytes once (nothing doubled)", async () => {
    const r = vmRig();
    await r.agent.boot();
    const { guest, file } = await recording(r);
    guest.init();
    await pull(r);
    guest.media(1);
    // The agent wrote the next fragment, then died before moving its cursor.
    appendFileSync(file, guest.made[1]!);
    appendFileSync(file, Buffer.from("half of something"));
    r.restart();
    await pull(r);
    expect(readFileSync(file)).toEqual(Buffer.concat(guest.made));
  });

  it("resumes after an agent restart from the stored cursor", async () => {
    const r = vmRig();
    await r.agent.boot();
    const { req, guest, file } = await recording(r);
    guest.init().media(1);
    await pull(r);
    r.restart();
    await r.agent.boot();
    guest.media(2);
    await pull(r);
    expect(ops(r)).toContain("fragments:2");
    expect(readFileSync(file)).toEqual(Buffer.concat(guest.made));
    expect(r.store.getPull(req.sessionId)?.seq).toBe(4);
  });

  it("does not hold other sessions' recordings behind a slow guest, nor ask a busy one twice", async () => {
    const r = vmRig();
    await r.agent.boot();
    const slow = await recording(r);
    const fast = await recording(r);
    slow.guest.init();
    fast.guest.init();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const orig = r.runtime.recordingFragments.bind(r.runtime);
    r.runtime.recordingFragments = async (address, token, after) => {
      if (address === slow.b.address) await gate;
      return orig(address, token, after);
    };
    r.agent.pullRecordings();
    await new Promise((res) => setTimeout(res, 50));
    expect(readFileSync(fast.file)).toEqual(fast.guest.made[0]);
    const asked = ops(r).length;
    r.agent.pullRecordings();
    await new Promise((res) => setTimeout(res, 50));
    // Only the fast guest was asked again.
    expect(r.runtime.calls.slice(asked).map((c) => c.address)).toEqual([
      fast.b.address,
    ]);
    release();
    await r.agent.idle();
    expect(readFileSync(slow.file)).toEqual(slow.guest.made[0]);
  });

  it("gives up on a guest with no pull recorder (an older runtimed)", async () => {
    const r = vmRig();
    await r.agent.boot();
    const { req, guest } = await recording(r);
    guest.answer = "404";
    await pull(r);
    expect(r.store.getPull(req.sessionId)?.done).toBe(true);
  });

  it("starts unrecorded when the host cannot make size-limited volumes", async () => {
    const r = vmRig();
    r.volumes!.failCreates = true;
    await r.agent.boot();
    const req = startReq({ recording: true });
    expect((await r.agent.start(req)).result).toBe("ready");
    const b = r.store.getBinding(req.sessionId)!;
    expect(r.runtime.configured.get(b.address!)).toMatchObject({
      recording: false,
    });
    expect(r.store.getPull(req.sessionId)).toBeUndefined();
  });

  it("forgets the cursor with the recording when retention ends", async () => {
    const r = vmRig();
    await r.agent.boot();
    const { req, guest, volume } = await recording(r);
    guest.init();
    await stop(r, req.sessionId);
    r.clock.advance(RECORDING_LIMITS.retentionMs + 1);
    await r.agent.reconcile();
    expect(r.volumes!.vols.has(volume)).toBe(false);
    expect(r.store.getPull(req.sessionId)).toBeUndefined();
  });
});

describe("checking an answer before it is appended", () => {
  const init = Buffer.concat([mp4Box("ftyp", 20), mp4Box("moov", 100)]);
  const frag = Buffer.concat([mp4Box("moof", 50), mp4Box("mdat", 200)]);
  const answer = (parts: Buffer[], from: number) => ({
    meta: {
      state: "recording" as const,
      fragments: parts.map((p, i) => ({ seq: from + 1 + i, bytes: p.length })),
      done: false,
    },
    body: Buffer.concat(parts),
  });
  it("accepts fragments that follow on, with ftyp only at the very start of the file", () => {
    expect(invalid(answer([init, frag], 0), { seq: 0, bytes: 0 })).toBeNull();
    expect(invalid(answer([frag], 2), { seq: 2, bytes: 500 })).toBeNull();
    expect(invalid(answer([frag], 2), { seq: 2, bytes: 0 })).toMatch(/ftyp/);
    expect(invalid(answer([init], 2), { seq: 2, bytes: 500 })).toMatch(/ftyp/);
    expect(invalid(answer([frag], 3), { seq: 2, bytes: 500 })).toMatch(
      /does not follow/,
    );
  });
});

describe("the runtime client's fragments call (hostile answers)", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());
  async function guest(
    answer: (res: ServerResponse) => void,
  ): Promise<HttpRuntimeClient> {
    server = createServer((_req, res) => answer(res));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return new HttpRuntimeClient((server.address() as { port: number }).port);
  }
  const meta = (bytes: number) =>
    JSON.stringify({
      state: "recording",
      fragments: [{ seq: 1, bytes }],
      done: false,
    });

  it("returns a body exactly the size described", async () => {
    const c = await guest((res) => {
      res.writeHead(200, { [RECORDING_FRAGMENTS_HEADER]: meta(4) });
      res.end("abcd");
    });
    const got = await c.recordingFragments("127.0.0.1", "t", 0);
    expect(got.body.toString()).toBe("abcd");
    expect(got.meta.fragments).toEqual([{ seq: 1, bytes: 4 }]);
  });

  it("refuses a missing, malformed or out-of-schema description, and a body of another size", async () => {
    const answers: ((res: ServerResponse) => void)[] = [
      (res) => res.writeHead(200).end("abcd"),
      (res) =>
        res.writeHead(200, { [RECORDING_FRAGMENTS_HEADER]: "{" }).end("abcd"),
      (res) =>
        res
          .writeHead(200, {
            [RECORDING_FRAGMENTS_HEADER]: JSON.stringify({
              state: "recording",
              fragments: [{ seq: 1, bytes: 4, path: "/etc/shadow" }],
              done: false,
            }),
          })
          .end("abcd"),
      (res) =>
        res
          .writeHead(200, { [RECORDING_FRAGMENTS_HEADER]: meta(4) })
          .end("abcdef"),
      (res) =>
        res.writeHead(200, { [RECORDING_FRAGMENTS_HEADER]: meta(4) }).end("ab"),
      (res) =>
        res
          .writeHead(200, {
            [RECORDING_FRAGMENTS_HEADER]: JSON.stringify({
              state: "recording",
              fragments: Array.from({ length: 2 }, (_, i) => ({
                seq: i + 1,
                bytes: RECORDING_LIMITS.fragmentBytes,
              })),
              done: false,
            }),
          })
          .end(),
      (res) =>
        res.writeHead(302, { location: "http://169.254.169.254/" }).end(),
    ];
    for (const a of answers) {
      const c = await guest(a);
      await expect(c.recordingFragments("127.0.0.1", "t", 0)).rejects.toThrow();
      server!.close();
    }
  });

  it("reports a 404 as such, so the agent can stop asking", async () => {
    const c = await guest((res) => res.writeHead(404).end("{}"));
    await expect(c.recordingFragments("127.0.0.1", "t", 0)).rejects.toEqual(
      expect.any(RuntimeHttpError),
    );
  });
});
