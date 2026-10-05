import type { CaptchaProvider } from "@kestrel/contracts";

/**
 * W2. The live-view page at `/live/<session id>`. Static: everything it needs (the gateway's
 * socket address and the token) is in the URL fragment, which the browser never sends to a
 * server, so the token reaches no log and no referrer. A `control` token also sends input.
 */
export const LIVE_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

/** What the viewer calls each CAPTCHA provider. Every provider has one (checked by a test). */
export const CAPTCHA_LABELS: Record<CaptchaProvider, string> = {
  recaptcha: "reCAPTCHA",
  hcaptcha: "hCaptcha",
  turnstile: "Cloudflare Turnstile",
  cloudflare_challenge: "Cloudflare challenge page",
  arkose: "Arkose",
  datadome: "DataDome",
};

export const LIVE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kestrel live view</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1c1c1a;--muted:#6b6b66;--line:#d9d9d4}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#eceae4;--muted:#9a988f;--line:#2e2d2a}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
#status{color:var(--muted)} select{max-width:50vw}
#captcha{margin:0;padding:8px 16px;background:#fff4c2;color:#3d3200;border-bottom:1px solid #e6d27a}
@media (prefers-color-scheme:dark){#captcha{background:#3d3200;color:#fff4c2;border-color:#6b5a10}}
main{display:flex;justify-content:center;align-items:flex-start;padding:16px}
canvas{max-width:100%;height:auto;border:1px solid var(--line);outline:none}
</style></head><body>
<header><strong>Kestrel live view</strong><span id="mode"></span><select id="tabs" aria-label="Tab"></select><span id="status">connecting…</span></header>
<p id="captcha" role="status" hidden></p>
<main><canvas id="screen" tabindex="0" width="1280" height="720"></canvas></main>
<script>
(function(){
  var f = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname); // keep the token out of history and screenshots of the address bar
  var token = f.get("token"), wsUrl = f.get("ws");
  var status = document.getElementById("status"), modeEl = document.getElementById("mode");
  var canvas = document.getElementById("screen"), ctx = canvas.getContext("2d"), tabs = document.getElementById("tabs");
  if (!token || !wsUrl || !/^wss:\\/\\//.test(wsUrl)) { status.textContent = "This link is incomplete."; return; }
  var scope = "view";
  try { scope = JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).scope; } catch (e) {}
  var control = scope === "control";
  modeEl.textContent = control ? "· control" : "· view only";
  var captchaEl = document.getElementById("captcha");
  // Fixed labels: anything else a page or the container sends is ignored (T-52).
  var LABELS = ${JSON.stringify(CAPTCHA_LABELS)};
  var ws = new WebSocket(wsUrl + "?token=" + encodeURIComponent(token));
  var page = { w: 1280, h: 720 };
  ws.onopen = function(){ status.textContent = "live"; };
  ws.onclose = function(e){ status.textContent = "disconnected (" + e.code + (e.reason ? ": " + e.reason : "") + ")"; };
  ws.onmessage = function(ev){
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === "frame") {
      var img = new Image();
      img.onload = function(){
        if (canvas.width !== img.width || canvas.height !== img.height) { canvas.width = img.width; canvas.height = img.height; }
        ctx.drawImage(img, 0, 0);
      };
      img.src = "data:image/jpeg;base64," + m.data;
      page = { w: m.width, h: m.height };
    } else if (m.type === "captcha") {
      var names = (Array.isArray(m.providers) ? m.providers : []).filter(function(p){ return Object.prototype.hasOwnProperty.call(LABELS, p); }).map(function(p){ return LABELS[p]; });
      captchaEl.hidden = names.length === 0;
      captchaEl.textContent = names.length === 0 ? "" : control
        ? "A CAPTCHA (" + names.join(", ") + ") is showing. Solve it here; the agent continues when you are done."
        : "A CAPTCHA (" + names.join(", ") + ") is showing. This link is view only: ask for a control link to solve it.";
    } else if (m.type === "tabs") {
      tabs.textContent = "";
      m.tabs.forEach(function(t){ var o = document.createElement("option"); o.value = t.id; o.textContent = (t.title || t.url || t.id).slice(0, 80); o.selected = !!t.active; tabs.appendChild(o); });
    }
  };
  tabs.onchange = function(){ ws.send(JSON.stringify({ type: "tab", id: tabs.value })); };
  if (!control) return;
  function at(e){ var r = canvas.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * page.w / r.width), y: Math.round((e.clientY - r.top) * page.h / r.height) }; }
  function send(o){ if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
  var buttons = ["left","middle","right"];
  canvas.addEventListener("mousedown", function(e){ canvas.focus(); var p = at(e); send({ type: "mouse", action: "down", x: p.x, y: p.y, button: buttons[e.button] || "left" }); e.preventDefault(); });
  canvas.addEventListener("mouseup", function(e){ var p = at(e); send({ type: "mouse", action: "up", x: p.x, y: p.y, button: buttons[e.button] || "left" }); });
  var lastMove = 0;
  canvas.addEventListener("mousemove", function(e){ var n = Date.now(); if (n - lastMove < 50) return; lastMove = n; var p = at(e); send({ type: "mouse", action: "move", x: p.x, y: p.y }); });
  canvas.addEventListener("wheel", function(e){ var p = at(e); send({ type: "wheel", x: p.x, y: p.y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }); e.preventDefault(); }, { passive: false });
  canvas.addEventListener("contextmenu", function(e){ e.preventDefault(); });
  canvas.addEventListener("keydown", function(e){
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) send({ type: "text", text: e.key });
    else send({ type: "key", key: e.key });
    e.preventDefault();
  });
})();
</script></body></html>`;
