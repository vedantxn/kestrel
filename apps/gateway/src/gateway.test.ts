import { CLOSE_CODES, PROOF_HEADER } from "@kestrel/contracts";
import type WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOf,
  makeRig,
  nextMessage,
  opened,
  pause,
  type Rig,
} from "./test/harness.js";

let rig: Rig;
afterEach(async () => rig?.close());

const rpc = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ id, method, params });

describe("authentication and routing (C7, C8)", () => {
  it("relays a CDP exchange, presenting the session proof to the container", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    ws.send(rpc(1, "Browser.getVersion"));
    expect(JSON.parse(await nextMessage(ws))).toEqual({
      id: 1,
      result: { echo: "Browser.getVersion" },
    });
    const upgrade = s.container.requests.find((r) => r.kind === "ws");
    expect(upgrade?.proof).toBe(s.proof);
    expect(upgrade?.path).toBe(`/devtools/browser/${s.container.browserId}`);
    ws.close();
  });

  it("accepts the token as a Bearer header too", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s, { bearer: true }));
    ws.send(rpc(2, "X"));
    expect(JSON.parse(await nextMessage(ws)).id).toBe(2);
    ws.close();
  });

  it("learns the browser path once and reuses it", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    for (let i = 0; i < 3; i++) (await opened(await rig.connect(s))).close();
    await pause(50);
    expect(
      s.container.requests.filter((r) => r.path === "/json/version"),
    ).toHaveLength(1);
  });

  it("serves page sockets and browser sockets by id", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const page = await opened(
      await rig.connect(s, { path: `/devtools/page/${s.container.pageId}` }),
    );
    page.send(rpc(3, "Page.enable"));
    expect(JSON.parse(await nextMessage(page)).id).toBe(3);
    const byId = await opened(
      await rig.connect(s, {
        path: `/devtools/browser/${s.container.browserId}`,
      }),
    );
    byId.send(rpc(4, "Target.getTargets"));
    expect(JSON.parse(await nextMessage(byId)).id).toBe(4);
    page.close();
    byId.close();
  });

  /** A refusal completes the handshake, then closes with the code: that is how a client learns why. */
  const refused = async (
    make: () => Promise<{ ws: WebSocket }>,
    code: number,
  ) => {
    const { ws } = await make();
    expect((await closeOf(ws)).code).toBe(code);
  };

  it("closes 4001 for a missing, garbage or expired token, and for one naming another session", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const other = await rig.addSession();
    await refused(
      async () => ({ ws: await rig.connect(s, { token: "" }) }),
      CLOSE_CODES.tokenInvalid,
    );
    await refused(
      async () => ({ ws: await rig.connect(s, { token: "not.a.token" }) }),
      CLOSE_CODES.tokenInvalid,
    );
    await refused(
      async () => ({
        ws: await rig.connect(s, { token: await rig.token(other) }),
      }),
      CLOSE_CODES.tokenInvalid,
    );
    await refused(
      async () => ({
        ws: await rig.connect(s, {
          token: await rig.token(s, { scope: "view" }),
        }),
      }),
      CLOSE_CODES.tokenInvalid,
    );
    await refused(
      async () => ({
        ws: await rig.connect(s, {
          token: await rig.token(s, { project: "prj_" + "0".repeat(26) }),
        }),
      }),
      CLOSE_CODES.tokenInvalid,
    );
    const t = await rig.token(s, { deadlineMs: rig.clock.now() + 1000 });
    rig.clock.advance(1000 + 61_000);
    await refused(
      async () => ({ ws: await rig.connect(s, { token: t }) }),
      CLOSE_CODES.tokenInvalid,
    );
  });

  it("closes 4003 for a valid token for a session on another node", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    await refused(
      async () => ({
        ws: await rig.connect(s, { token: await rig.token(s, { nod: "b" }) }),
      }),
      CLOSE_CODES.notOnThisNode,
    );
  });

  it("closes 4002 when the route is gone or past its time, even with a valid token", async () => {
    rig = await makeRig();
    const gone = await rig.addSession();
    const token = await rig.token(gone);
    rig.table.remove(gone.id);
    await refused(
      async () => ({ ws: await rig.connect(gone, { token }) }),
      CLOSE_CODES.sessionEnded,
    );

    const old = await rig.addSession({ notAfterSec: 10 });
    const t2 = await rig.token(old);
    rig.clock.advance(11_000);
    await refused(
      async () => ({ ws: await rig.connect(old, { token: t2 }) }),
      CLOSE_CODES.sessionEnded,
    );
  });

  it("closes 4002 if the container cannot be reached", async () => {
    rig = await makeRig({ upstreamTimeoutMs: 500 });
    const s = await rig.addSession();
    await s.container.stop();
    await refused(
      async () => ({ ws: await rig.connect(s) }),
      CLOSE_CODES.sessionEnded,
    );
  });

  it("never reaches a container that does not accept the proof", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    // The route holds a stale proof, as if the address had been reused by a different session (C10).
    const entry = rig.table.get(s.id)!;
    rig.table.put({ ...entry, proof: "00".repeat(32) });
    await refused(
      async () => ({ ws: await rig.connect(s) }),
      CLOSE_CODES.sessionEnded,
    );
  });

  it("does not serve anything else", async () => {
    rig = await makeRig();
    expect((await rig.http("/healthz")).status).toBe(200);
    expect((await rig.http("/")).status).toBe(404);
    expect((await rig.http("/v1/sessions")).status).toBe(404);
    expect((await rig.http("/metrics")).status).toBe(404);
  });
});

describe("relay integrity (C5)", () => {
  it("passes messages untouched and in order, in both directions", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    const got: number[] = [];
    const done = new Promise<void>((resolve) =>
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        if (m.method === "Test.event") got.push(m.params.i);
        if (m.id === 99) resolve();
      }),
    );
    ws.send(rpc(99, "Test.stream", { n: 2000 }));
    await done;
    expect(got).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    ws.close();
  });

  it("relays text that is not JSON, and binary frames, byte for byte (the gateway never parses CDP)", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    ws.send("this {is not json");
    expect(await nextMessage(ws)).toBe("this {is not json");
    const bin = Buffer.from([0, 1, 2, 250, 251, 252]);
    const back = new Promise<{ data: Buffer; isBinary: boolean }>((r) =>
      ws.once("message", (data, isBinary) =>
        r({ data: data as Buffer, isBinary }),
      ),
    );
    ws.send(bin, { binary: true });
    const r = await back;
    expect(r.isBinary).toBe(true);
    expect(Buffer.compare(r.data, bin)).toBe(0);
    ws.close();
  });

  it("relays a large message whole", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    ws.send(rpc(5, "Test.big", { size: 20 * 1024 * 1024 }));
    const m = JSON.parse(await nextMessage(ws));
    expect(m.result.blob.length).toBe(20 * 1024 * 1024);
    ws.close();
  });

  it("refuses a message over the size limit with 1009", async () => {
    rig = await makeRig({ limits: { maxMessageBytes: 64 * 1024 } });
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    ws.send("x".repeat(100 * 1024));
    expect((await closeOf(ws)).code).toBe(1009);
  });

  it("closes the client with an error code when the container dies, and the session's other state is untouched", async () => {
    rig = await makeRig();
    const a = await rig.addSession();
    const b = await rig.addSession();
    const wa = await opened(await rig.connect(a));
    const wb = await opened(await rig.connect(b));
    a.container.kill();
    expect((await closeOf(wa)).code).toBe(1011);
    wb.send(rpc(7, "Still.alive"));
    expect(JSON.parse(await nextMessage(wb)).id).toBe(7);
    wb.close();
  });

  it("lets the session outlive its client: a closed client does not touch the container", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(await rig.connect(s));
    ws.close();
    await pause(100);
    expect(s.container.sockets.size).toBe(0);
    const again = await opened(await rig.connect(s));
    again.send(rpc(8, "Reconnected"));
    expect(JSON.parse(await nextMessage(again)).id).toBe(8);
    again.close();
  });
});

describe("discovery (C2)", () => {
  it("rewrites /json/version to the public wss address and keeps the token", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const token = await rig.token(s);
    for (const path of ["/json/version", "/json/version/"]) {
      const r = await rig.http(
        `/v1/sessions/${s.id}/cdp${path}?token=${encodeURIComponent(token)}`,
      );
      expect(r.status).toBe(200);
      const v = JSON.parse(r.body);
      expect(v.Browser).toMatch(/^Chrome\//);
      const u = new URL(v.webSocketDebuggerUrl);
      expect(u.protocol).toBe("wss:");
      expect(u.host).toBe("1-2-3-4.sslip.io:8443");
      expect(u.pathname).toBe(
        `/v1/sessions/${s.id}/cdp/devtools/browser/${s.container.browserId}`,
      );
      expect(u.searchParams.get("token")).toBe(token);
      expect(v.webSocketDebuggerUrl).not.toContain("127.0.0.1");
    }
    expect(s.container.requests.every((x) => x.proof === s.proof)).toBe(true);
  });

  it("hands out ws:// addresses in local mode", async () => {
    rig = await makeRig({
      publicHostname: "192.168.1.10",
      publicSecure: false,
    });
    const s = await rig.addSession();
    const token = await rig.token(s);
    const r = await rig.http(
      `/v1/sessions/${s.id}/cdp/json/version?token=${encodeURIComponent(token)}`,
    );
    expect(r.status).toBe(200);
    const u = new URL(JSON.parse(r.body).webSocketDebuggerUrl);
    expect(u.protocol).toBe("ws:");
    expect(u.host).toBe("192.168.1.10:8443");
  });

  it("rewrites the target list and drops the frontend url", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const token = await rig.token(s);
    for (const path of ["/json", "/json/list", "/json/list/"]) {
      const r = await rig.http(`/v1/sessions/${s.id}/cdp${path}`, {
        authorization: `Bearer ${token}`,
      });
      expect(r.status).toBe(200);
      const [page] = JSON.parse(r.body);
      expect(page.devtoolsFrontendUrl).toBeUndefined();
      const u = new URL(page.webSocketDebuggerUrl);
      expect(u.host).toBe("1-2-3-4.sslip.io:8443");
      expect(u.pathname).toBe(
        `/v1/sessions/${s.id}/cdp/devtools/page/${s.container.pageId}`,
      );
    }
  });

  it("is authenticated like the websocket", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    expect(
      (await rig.http(`/v1/sessions/${s.id}/cdp/json/version`)).status,
    ).toBe(401);
    expect(
      (await rig.http(`/v1/sessions/${s.id}/cdp/json/version?token=bad`))
        .status,
    ).toBe(401);
    expect(
      (
        await rig.http(
          `/v1/sessions/${s.id}/cdp/json/version?token=${await rig.token(s, { nod: "b" })}`,
        )
      ).status,
    ).toBe(421);
    rig.table.remove(s.id);
    expect(
      (
        await rig.http(
          `/v1/sessions/${s.id}/cdp/json/version?token=${await rig.token(s)}`,
        )
      ).status,
    ).toBe(410);
  });

  it("answers 502 when the container does not, and says to use a websocket on a socket path", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const token = await rig.token(s);
    s.container.discoveryStatus = 500;
    expect(
      (await rig.http(`/v1/sessions/${s.id}/cdp/json/version?token=${token}`))
        .status,
    ).toBe(502);
    expect(
      (await rig.http(`/v1/sessions/${s.id}/cdp?token=${token}`)).status,
    ).toBe(426);
  });

  it("never sends a proof it was not given by the route", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    await rig.http(
      `/v1/sessions/${s.id}/cdp/json/version?token=${await rig.token(s)}`,
      { [PROOF_HEADER]: "attacker-supplied" },
    );
    expect(s.container.requests.every((r) => r.proof === s.proof)).toBe(true);
  });
});
