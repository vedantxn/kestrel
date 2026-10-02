import { describe, expect, it } from "vitest";
import {
  AgentMessage,
  GatewayMessage,
  MAX_FRAME_BYTES,
  decodeLine,
  encodeLine,
} from "./agent-gateway.js";
import { DenialsResponse, EgressPolicy } from "./egress-control.js";
import { SessionEvent } from "./events.js";
import { newId } from "./ids.js";
import {
  HeartbeatRequest,
  HeartbeatResponse,
  Report,
  ReportsRequest,
  StartRequest,
  StartResponse,
} from "./node-protocol.js";
import { ConfigureRequest, RuntimeHealth } from "./runtime-control.js";
import { ErrorResponse, errorResponse } from "./errors.js";
import { TokenClaims } from "./tokens.js";

const ses = newId("ses");
const prj = newId("prj");
const proof = "ab".repeat(32);
const now = "2026-10-02T12:00:00.000Z";

describe("node protocol", () => {
  it("parses a start request and every kind of response", () => {
    StartRequest.parse({
      sessionId: ses,
      projectId: prj,
      epoch: 3,
      viewport: { width: 1280, height: 720 },
      network: { allow: ["example.com"] },
      timeoutMs: 900_000,
      idleTimeoutMs: 300_000,
      stopOnDisconnect: false,
    });
    expect(
      StartResponse.parse({
        result: "ready",
        startPath: "hot",
        readyMs: 12,
        deviceScaleFactor: 1,
      }).result,
    ).toBe("ready");
    expect(
      StartResponse.parse({ result: "refused", reason: "stale epoch" }).result,
    ).toBe("refused");
    expect(StartResponse.safeParse({ result: "ready" }).success).toBe(false);
  });

  it("carries the heartbeat and its reconciliation", () => {
    HeartbeatRequest.parse({
      nodeId: "a",
      epoch: 1,
      protocolVersion: 1,
      slots: { total: 5, free: 3 },
      hotCount: 2,
      sessions: [{ sessionId: ses, state: "ready" }],
      pendingReports: 0,
    });
    const r = HeartbeatResponse.parse({
      epoch: 2,
      fenced: true,
      stop: [{ sessionId: ses, reason: "node_lost" }],
      unknown: [],
    });
    expect(r.fenced).toBe(true);
  });

  it("accepts node-reportable events and refuses ones only the API writes", () => {
    const ok = {
      id: "r1",
      at: now,
      kind: "event",
      sessionId: ses,
      event: {
        type: "egress.denied",
        data: {
          host: "x.test",
          port: 443,
          reason: "blocked_address",
          count: 3,
        },
      },
    };
    expect(Report.safeParse(ok).success).toBe(true);
    const bad = {
      ...ok,
      event: { type: "session.ready", data: { startPath: "hot", readyMs: 1 } },
    };
    expect(Report.safeParse(bad).success).toBe(false);
    expect(
      Report.safeParse({
        id: "r2",
        at: now,
        kind: "removed",
        sessionId: ses,
        endReason: null,
        browserSeconds: 4.2,
      }).success,
    ).toBe(true);
    expect(
      ReportsRequest.safeParse({ nodeId: "a", epoch: 1, reports: [] }).success,
    ).toBe(false);
  });
});

describe("agent-gateway socket", () => {
  it("round-trips newline-delimited messages", () => {
    const route = {
      sessionId: ses,
      projectId: prj,
      address: "172.30.1.5",
      port: 9223,
      proof,
      notAfter: 1_800_000_000,
    };
    const line = encodeLine({ type: "route.put", route });
    expect(line.endsWith("\n")).toBe(true);
    expect(decodeLine(AgentMessage, line.trimEnd())).toEqual({
      type: "route.put",
      route,
    });
    const hello = {
      type: "hello",
      protocolVersion: 1,
      gatewayId: "g1",
      attachments: [{ sessionId: ses, connections: 2 }],
    };
    expect(decodeLine(GatewayMessage, JSON.stringify(hello))).toEqual(hello);
  });

  it("treats garbage, wrong shapes and oversized lines as no message", () => {
    expect(decodeLine(AgentMessage, "not json")).toBeNull();
    expect(
      decodeLine(
        AgentMessage,
        JSON.stringify({ type: "route.put", route: { sessionId: ses } }),
      ),
    ).toBeNull();
    expect(
      decodeLine(
        AgentMessage,
        JSON.stringify({ type: "route.put", route: { address: "999.1.1.1" } }),
      ),
    ).toBeNull();
    expect(
      decodeLine(AgentMessage, "x".repeat(MAX_FRAME_BYTES + 1)),
    ).toBeNull();
  });
});

describe("egress control", () => {
  it("defaults the connection cap and validates patterns", () => {
    expect(EgressPolicy.parse({ sessionId: ses }).connectionCap).toBe(256);
    expect(
      EgressPolicy.safeParse({ sessionId: ses, deny: ["not a host"] }).success,
    ).toBe(false);
  });

  it("parses denials", () => {
    expect(
      DenialsResponse.parse({
        epoch: "e1",
        denials: [
          {
            seq: 0,
            sessionId: ses,
            host: "169.254.169.254",
            port: 80,
            reason: "blocked_address",
            count: 1,
            at: now,
          },
        ],
      }).denials,
    ).toHaveLength(1);
  });
});

describe("runtime control", () => {
  it("validates configure and health", () => {
    ConfigureRequest.parse({
      sessionProof: proof,
      viewport: { width: 1280, height: 720 },
    });
    expect(
      ConfigureRequest.safeParse({
        sessionProof: "short",
        viewport: { width: 1280, height: 720 },
      }).success,
    ).toBe(false);
    RuntimeHealth.parse({
      protocolVersion: 1,
      status: "ready",
      chromeReady: true,
      chromeVersion: "154.0.8037.92",
    });
  });
});

describe("events, tokens, errors", () => {
  it("parses an event and rejects a payload of the wrong type", () => {
    const base = { id: newId("evt"), sessionId: ses, at: now };
    expect(
      SessionEvent.safeParse({
        ...base,
        type: "session.ready",
        data: { startPath: "cold", readyMs: 900 },
      }).success,
    ).toBe(true);
    expect(
      SessionEvent.safeParse({
        ...base,
        type: "session.ready",
        data: { nodeId: "a" },
      }).success,
    ).toBe(false);
    expect(
      SessionEvent.safeParse({ ...base, type: "session.exploded", data: {} })
        .success,
    ).toBe(false);
  });

  it("parses token claims", () => {
    expect(
      TokenClaims.safeParse({
        iss: "kestrel",
        sub: ses,
        prj,
        nod: "a",
        scope: "cdp",
        iat: 1,
        exp: 2,
      }).success,
    ).toBe(true);
    expect(
      TokenClaims.safeParse({
        iss: "other",
        sub: ses,
        prj,
        nod: "a",
        scope: "cdp",
        iat: 1,
        exp: 2,
      }).success,
    ).toBe(false);
  });

  it("builds the one error shape", () => {
    const e = errorResponse("capacity_exhausted", "full", "req_1");
    expect(ErrorResponse.parse(e).error.retryable).toBe(true);
    expect(
      errorResponse("invalid_request", "bad", "req_2", "timeout").error,
    ).toEqual({
      code: "invalid_request",
      message: "bad",
      retryable: false,
      requestId: "req_2",
      param: "timeout",
    });
  });
});
