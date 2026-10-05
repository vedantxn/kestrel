// Experiment V7, uniqueness: do browsers restored from one snapshot share random state?
// Run in the platform image on the host network, after `v7.py keep K`:
//   docker run --rm --network host -v /srv/kestrel:/w -w /w kestrel-platform:dev \
//     node runtime/experiments/v7/uniq.mjs K
// For each clone it reads crypto.getRandomValues and crypto.randomUUID from the page, and makes
// two TLS connections through the clone's proxy address to a recorder here that keeps each
// ClientHello's random, legacy session id and key share. Every value must differ across clones.
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import WebSocket from "ws";

const K = Number(process.argv[2] ?? 3);
const PROOF = "ab".repeat(32);
const hellos = [];

// A CONNECT proxy that never connects anywhere: it answers 200, reads the ClientHello, records it.
const proxy = createServer((sock) => {
  let buf = Buffer.alloc(0);
  let tunnelled = false;
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (!tunnelled) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      tunnelled = true;
      buf = buf.subarray(end + 4);
      sock.write("HTTP/1.1 200 Connection established\r\n\r\n");
    }
    // TLS record: type(1) version(2) length(2), then handshake: type(1) length(3) version(2) random(32) sid_len(1) sid
    if (buf.length < 5) return;
    const len = buf.readUInt16BE(3);
    if (buf.length < 5 + len) return;
    const hs = buf.subarray(5, 5 + len);
    if (hs[0] !== 1) return sock.destroy();
    const random = hs.subarray(6, 38).toString("hex");
    const sidLen = hs[38];
    const sid = hs.subarray(39, 39 + sidLen).toString("hex");
    // The whole hello minus nothing: key shares live in the extensions, hashed here for comparison.
    const rest = createHash("sha256")
      .update(hs.subarray(39 + sidLen))
      .digest("hex");
    hellos.push({ from: sock.remoteAddress, random, sid, rest });
    sock.destroy();
  });
  sock.on("error", () => undefined);
});
await new Promise((r) => proxy.listen(3199, "0.0.0.0", r));

async function cdp(addr) {
  const v = await fetch(`http://${addr}:9223/json/version`, {
    headers: { "x-kestrel-session-proof": PROOF },
  }).then((r) => r.json());
  const ws = new WebSocket(
    v.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${addr}:9223`),
    {
      headers: { "x-kestrel-session-proof": PROOF },
    },
  );
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  let id = 0;
  const waiting = new Map();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((r) => {
      const i = ++id;
      waiting.set(i, r);
      ws.send(
        JSON.stringify({
          id: i,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  return { ws, send };
}

const results = [];
for (let i = 1; i <= K; i++) {
  const addr = `10.200.${i}.2`;
  const { ws, send } = await cdp(addr);
  const t = await send("Target.getTargets");
  let page = t.result.targetInfos.find((x) => x.type === "page");
  if (process.env.FRESH_PAGE === "1") {
    // The mitigation under test: a page made after the restore, in a new renderer process.
    const n = await send("Target.createTarget", {
      url: "about:blank",
      newWindow: false,
    });
    await send("Target.closeTarget", { targetId: page.targetId });
    page = { targetId: n.result.targetId };
  }
  const a = await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  const s = a.result.sessionId;
  const ev = await send(
    "Runtime.evaluate",
    {
      expression:
        "JSON.stringify({r: Array.from(crypto.getRandomValues(new Uint8Array(16))), u: (crypto.randomUUID ? crypto.randomUUID() : null), m: Math.random()})",
      returnByValue: true,
    },
    s,
  );
  const before = hellos.length;
  for (const host of ["a.v7.test", "b.v7.test"]) {
    await send("Page.navigate", { url: `https://${host}/` }, s);
    for (
      let w = 0;
      w < 50 && hellos.length === before + (host === "a.v7.test" ? 0 : 1);
      w++
    )
      await new Promise((r) => setTimeout(r, 100));
  }
  if (!ev.result?.result?.value)
    throw new Error(`clone ${i}: ${JSON.stringify(ev).slice(0, 400)}`);
  results.push({ clone: i, page: JSON.parse(ev.result.result.value) });
  ws.close();
}
await new Promise((r) => setTimeout(r, 500));

const dup = (xs) => xs.length !== new Set(xs).size;
const out = {
  clones: K,
  hellos: hellos.length,
  pageRandom: results.map((r) => r.page),
  duplicated: {
    getRandomValues: dup(results.map((r) => JSON.stringify(r.page.r))),
    randomUUID: dup(results.map((r) => r.page.u)),
    mathRandom: dup(results.map((r) => r.page.m)),
    tlsRandom: dup(hellos.map((h) => h.random)),
    tlsSessionId: dup(hellos.map((h) => h.sid)),
    randomUUIDs: results.map((r) => r.page.u),
    tlsKeyShareAndExtensions: dup(hellos.map((h) => h.rest)),
  },
  hellosDetail: hellos,
};
console.log(JSON.stringify(out, null, 2));
proxy.close();
process.exit(0);
