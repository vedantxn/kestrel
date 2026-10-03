import { CLOSE_CODES } from "@kestrel/contracts";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOf,
  makeRig,
  nextMessage,
  opened,
  pause,
  type Rig,
  type Session,
} from "./test/harness.js";

let rig: Rig;
afterEach(async () => rig?.close());

const liveUrl = (s: Session, token: string) =>
  `ws://${rig.host}/v1/sessions/${s.id}/live?token=${encodeURIComponent(token)}`;
const open = (url: string) => new WebSocket(url, { perMessageDeflate: false });

describe("live view through the gateway (W1, W2)", () => {
  it("relays a view socket to runtimed's live path with the mode from the token", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(
      open(liveUrl(s, await rig.token(s, { scope: "view" }))),
    );
    ws.send(JSON.stringify({ id: 1, method: "ping" }));
    expect(JSON.parse(await nextMessage(ws)).id).toBe(1);
    const up = s.container.requests.find((r) => r.path === "/kestrel/live");
    expect(up?.proof).toBe(s.proof);
    expect(up?.liveMode).toBe("view");
    ws.close();
  });

  it("passes control mode for a control token", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(
      open(liveUrl(s, await rig.token(s, { scope: "control" }))),
    );
    await pause(20);
    expect(
      s.container.requests.find((r) => r.path === "/kestrel/live")?.liveMode,
    ).toBe("control");
    ws.close();
  });

  it("refuses a cdp token on the live path and a live token on the CDP path", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const a = open(liveUrl(s, await rig.token(s, { scope: "cdp" })));
    expect((await closeOf(a)).code).toBe(CLOSE_CODES.tokenInvalid);
    const b = await rig.connect(s, {
      token: await rig.token(s, { scope: "view" }),
    });
    expect((await closeOf(b)).code).toBe(CLOSE_CODES.tokenInvalid);
    const c = await rig.connect(s, {
      token: await rig.token(s, { scope: "control" }),
    });
    expect((await closeOf(c)).code).toBe(CLOSE_CODES.tokenInvalid);
  });

  it("does not count a view-only viewer as activity, but counts a control one", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const view = await opened(
      open(liveUrl(s, await rig.token(s, { scope: "view" }))),
    );
    await pause(20);
    expect(rig.gateway.attachments()).toEqual([]);
    const control = await opened(
      open(liveUrl(s, await rig.token(s, { scope: "control" }))),
    );
    await pause(20);
    expect(rig.gateway.attachments()).toEqual([
      { sessionId: s.id, connections: 1 },
    ]);
    view.close();
    control.close();
  });

  it("accepts a single-use token once", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const t = await rig.token(s, {
      scope: "view",
      jti: "0123456789abcdef0123",
    });
    const first = await opened(open(liveUrl(s, t)));
    const second = open(liveUrl(s, t));
    expect((await closeOf(second)).code).toBe(CLOSE_CODES.tokenInvalid);
    first.close();
  });

  it("closes live viewers when the session's route goes away", async () => {
    rig = await makeRig();
    const s = await rig.addSession();
    const ws = await opened(
      open(liveUrl(s, await rig.token(s, { scope: "view" }))),
    );
    rig.table.remove(s.id);
    rig.gateway.closeSession(s.id, CLOSE_CODES.sessionEnded, "session ended");
    expect((await closeOf(ws)).code).toBe(CLOSE_CODES.sessionEnded);
  });
});
