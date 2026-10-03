import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECORDING_FILE, RECORDING_LIMITS } from "@kestrel/contracts";
import { describe, expect, it } from "vitest";
import { buildContainerSpec } from "./docker.js";
import { SPEC, makeRig, startReq } from "./test/fakes.js";

const volumeOf = (r: ReturnType<typeof makeRig>, containerId: string) =>
  r.docker.containers.get(containerId)?.labels["kestrel.volume"];

describe("recording volumes (W3)", () => {
  it("gives every container a size-limited volume mounted at /artifacts", () => {
    const spec = buildContainerSpec(
      SPEC,
      "pool",
      "t".repeat(48),
      "kestrel-rec-a-x",
    );
    expect(spec.HostConfig?.Mounts).toEqual([
      {
        Type: "volume",
        Source: "kestrel-rec-a-x",
        Target: "/artifacts",
        ReadOnly: false,
      },
    ]);
    expect(spec.Labels?.["kestrel.volume"]).toBe("kestrel-rec-a-x");
    expect(
      buildContainerSpec(SPEC, "pool", "t".repeat(48)).HostConfig?.Mounts,
    ).toBeUndefined();
  });

  it("records when asked, keeps the volume after the session, and stops the recorder first", async () => {
    const r = makeRig({}, { volumes: true });
    await r.agent.boot();
    const req = startReq({ recording: true });
    await r.agent.start(req);
    const b = r.store.getBinding(req.sessionId)!;
    const vol = volumeOf(r, b.containerId!)!;
    expect(vol).toMatch(/^kestrel-rec-a-[0-9a-f]{16}$/);
    expect(r.runtime.configured.get(b.address!)).toMatchObject({
      recording: true,
    });
    expect(r.store.getRecording(req.sessionId)?.volume).toBe(vol);

    await r.agent.stop({
      sessionId: req.sessionId,
      reason: "client_stop",
    } as never);
    await r.agent.idle();
    expect(r.runtime.calls.map((c) => c.op)).toContain("stopRecording");
    expect(r.volumes!.vols.has(vol)).toBe(true);
  });

  it("removes the volume of a session that did not record", async () => {
    const r = makeRig({}, { volumes: true });
    await r.agent.boot();
    const req = startReq();
    await r.agent.start(req);
    const b = r.store.getBinding(req.sessionId)!;
    const vol = volumeOf(r, b.containerId!)!;
    expect(r.runtime.configured.get(b.address!)).toMatchObject({
      recording: false,
    });
    await r.agent.stop({
      sessionId: req.sessionId,
      reason: "client_stop",
    } as never);
    await r.agent.idle();
    expect(r.volumes!.removed).toContain(vol);
    expect(r.runtime.calls.map((c) => c.op)).not.toContain("stopRecording");
  });

  it("starts unrecorded when the host cannot limit volume size", async () => {
    const r = makeRig({}, { volumes: true });
    r.volumes!.failCreates = true;
    await r.agent.boot();
    const req = startReq({ recording: true });
    expect((await r.agent.start(req)).result).toBe("ready");
    const b = r.store.getBinding(req.sessionId)!;
    expect(r.runtime.configured.get(b.address!)).toMatchObject({
      recording: false,
    });
    expect(r.store.getRecording(req.sessionId)).toBeUndefined();
  });

  it("reaps orphan volumes and recordings past retention, but not young volumes", async () => {
    const r = makeRig({}, { volumes: true });
    await r.agent.boot();
    await r.volumes!.create("kestrel-rec-a-orphan");
    await r.agent.reconcile();
    expect(r.volumes!.vols.has("kestrel-rec-a-orphan")).toBe(true); // younger than the grace
    r.clock.advance(r.config.newContainerGraceMs + 1);
    await r.agent.reconcile();
    expect(r.volumes!.vols.has("kestrel-rec-a-orphan")).toBe(false);

    const req = startReq({ recording: true });
    await r.agent.start(req);
    const vol = r.store.getRecording(req.sessionId)!.volume;
    await r.agent.stop({
      sessionId: req.sessionId,
      reason: "client_stop",
    } as never);
    await r.agent.idle();
    r.clock.advance(RECORDING_LIMITS.retentionMs - 60_000);
    await r.agent.reconcile();
    expect(r.volumes!.vols.has(vol)).toBe(true);
    r.clock.advance(120_000);
    await r.agent.reconcile();
    expect(r.volumes!.vols.has(vol)).toBe(false);
    expect(r.store.getRecording(req.sessionId)).toBeUndefined();
  });

  it("reads the recording back, but never through a link the container planted", async () => {
    const r = makeRig({}, { volumes: true });
    await r.agent.boot();
    const req = startReq({ recording: true });
    await r.agent.start(req);
    const vol = r.store.getRecording(req.sessionId)!.volume;
    const file = join(r.volumes!.root, vol, RECORDING_FILE);
    writeFileSync(file, Buffer.from("fmp4 bytes"));
    const rec = await r.agent.openRecording(req.sessionId);
    expect(rec?.size).toBe(10);
    await rec?.fd.close();

    const other = startReq({ recording: true });
    await r.agent.start(other);
    const vol2 = r.store.getRecording(other.sessionId)!.volume;
    symlinkSync(r.dbPath, join(r.volumes!.root, vol2, RECORDING_FILE));
    expect(await r.agent.openRecording(other.sessionId)).toBeNull();
    expect(await r.agent.openRecording("ses_unknown")).toBeNull();
  });
});
