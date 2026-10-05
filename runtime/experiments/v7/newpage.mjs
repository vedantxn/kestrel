// Time Target.createTarget (a new renderer) on a VM's browser through the CDP forward.
import WebSocket from "ws";
const [addr, proof, token] = process.argv.slice(2);
if (token) {
  await fetch(`http://${addr}:9000/configure`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sessionProof: proof,
      viewport: { width: 1280, height: 720 },
    }),
  }).then((r) => r.text());
}
const v = await fetch(`http://${addr}:9223/json/version`, {
  headers: { "x-kestrel-session-proof": proof },
}).then((r) => r.json());
const ws = new WebSocket(
  v.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${addr}:9223`),
  { headers: { "x-kestrel-session-proof": proof } },
);
await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
let id = 0;
const w = new Map();
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.id && w.has(m.id)) {
    w.get(m.id)(m);
    w.delete(m.id);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((r) => {
    const i = ++id;
    w.set(i, r);
    ws.send(
      JSON.stringify({
        id: i,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
for (let k = 0; k < 3; k++) {
  const t0 = performance.now();
  const n = await send("Target.createTarget", { url: "about:blank" });
  const a = await send("Target.attachToTarget", {
    targetId: n.result.targetId,
    flatten: true,
  });
  await send("Runtime.evaluate", { expression: "1+1" }, a.result.sessionId);
  console.log(`new page ${k}: ${Math.round(performance.now() - t0)} ms`);
}
process.exit(0);
