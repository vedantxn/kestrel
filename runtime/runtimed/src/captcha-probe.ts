import { Cdp, getVersion } from "./cdp.js";
import {
  MAX_TARGET_STRING,
  matchFrame,
  type DomSignals,
  type PageSignals,
  type Widget,
} from "./captcha-match.js";
import type { SolvableCaptchaProvider } from "@kestrel/contracts";

/**
 * The page half of CAPTCHA detection (`docs/lld/captcha.md`, "Pages"): what target discovery
 * cannot see. Same-site frames run in their page's process and are not targets, and in-page
 * widgets (HUMAN press-and-hold, GeeTest, AWS WAF, a Cloudflare challenge in any language) are
 * not frames at all.
 *
 * One connection of its own, attached to each page flattened and never paused, with **no domain
 * enabled**. Per page it reads the frame tree (`Page.getFrameTree`, answered by the browser's own
 * state) and, when the page is new, changed, or has something worth watching, runs a fixed,
 * read-only expression in an isolated world (`Page.createIsolatedWorld`, `Runtime.evaluate` with
 * that world's context): the page's JavaScript cannot see an isolated world's reads, and the
 * spike found no trace of them in the page (no trapped call, no mutation, the back/forward cache
 * still restores).
 *
 * Only a session that solves ever writes: `inject` fills the widget's response field from the
 * isolated world and calls the widget's callback in the page's own world, which the page can
 * see (that is the trade, documented as T-57).
 */

/** Commands the probe sends. Tests hold it to these (T-53). */
export const PROBE_COMMANDS = [
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Runtime.evaluate",
] as const;
/** Added only by `inject`, for a session that solves. */
export const INJECT_COMMANDS = [
  "Runtime.callFunctionOn",
  "Runtime.releaseObject",
] as const;

/** The isolated world's name: never visible to the page. */
const WORLD = "__kestrel_probe";
/** Pages probed at once; more are left to target discovery alone. */
export const MAX_PROBED_PAGES = 16;
const MAX_FRAMES_PER_PAGE = 200;
/** A page is probed at every read for this long after its URL, title or frames change... */
const YOUNG_MS = 10_000;
/** ...and then, with nothing found, this often. */
const PROBE_EVERY_MS = 10_000;
const CALL_TIMEOUT_MS = 1000;
/** A page whose answer broke the connection (too large) is skipped for this long. */
const PENALTY_MS = 30_000;
/** Frame trees and results are small; a page cannot make this connection buffer much. */
const MAX_PAYLOAD = 4 * 1024 * 1024;

/**
 * The probe, in an isolated world: reads only, bounded loops, a small answer. `WIDGETS` is
 * replaced with `true` for a session that solves (site keys and callbacks), `false` otherwise.
 */
const PROBE_SOURCE = `(() => {
  const d = document;
  const shown = (e) => {
    if (!e || !e.isConnected) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    return typeof e.checkVisibility === "function"
      ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      : true;
  };
  const any = (sel) => {
    const l = d.querySelectorAll(sel);
    for (let i = 0; i < l.length && i < 50; i++) if (shown(l[i])) return true;
    return false;
  };
  const script = (re) => {
    const l = d.scripts;
    for (let i = 0; i < l.length && i < 500; i++) {
      const s = l[i].src;
      if (s && s.length <= 2048 && re.test(s)) return true;
    }
    return false;
  };
  const out = {
    cf:
      script(/^https?:\\/\\/[^/]+\\/cdn-cgi\\/challenge-platform\\/h\\/[^/]+\\/orchestrate\\/(chl_page|managed|jsch|captcha)\\//) ||
      d.querySelector("form#challenge-form") !== null,
    px: shown(d.getElementById("px-captcha")),
    gt: any(".geetest_captcha, .geetest_holder, .geetest_panel_box"),
    aws: script(/^https:\\/\\/[^/]+\\.captcha\\.awswaf\\.com\\/.*captcha\\.js([?#]|$)/),
  };
  if (WIDGETS) {
    const w = [];
    const l = d.querySelectorAll(".g-recaptcha, .h-captcha, .cf-turnstile");
    for (let i = 0; i < l.length && w.length < 8; i++) {
      const e = l[i];
      const a = (n) => {
        const v = e.getAttribute(n);
        return v === null ? null : v.slice(0, 256);
      };
      w.push({
        p: e.classList.contains("g-recaptcha") ? "recaptcha" : e.classList.contains("h-captcha") ? "hcaptcha" : "turnstile",
        k: a("data-sitekey"),
        cb: a("data-callback"),
        s: a("data-size"),
        ac: a("data-action"),
        cd: a("data-cdata"),
      });
    }
    out.w = w;
  }
  return out;
})()`;

export const probeExpression = (widgets: boolean): string =>
  PROBE_SOURCE.replace("WIDGETS", widgets ? "true" : "false");

/**
 * Inject, part 1, in the isolated world: put the token into the widget's response fields. The
 * selectors are constants; the page's data (site key) is only compared, never interpolated.
 */
export const FILL_FUNCTION = `function (provider, siteKey, token) {
  const cls = { recaptcha: "g-recaptcha", hcaptcha: "h-captcha", turnstile: "cf-turnstile" }[provider];
  const names = { recaptcha: ["g-recaptcha-response"], hcaptcha: ["h-captcha-response", "g-recaptcha-response"], turnstile: ["cf-turnstile-response"] }[provider];
  if (!cls) return { fields: 0, callback: null };
  const all = Array.prototype.slice.call(document.getElementsByClassName(cls), 0, 50);
  let boxes = all.filter((e) => e.getAttribute("data-sitekey") === siteKey);
  if (boxes.length === 0 && all.length === 1) boxes = all;
  const scopes = boxes.length ? boxes : [document];
  const fields = [];
  for (const b of scopes)
    for (const n of names) {
      const l = b.querySelectorAll('textarea[name="' + n + '"], input[name="' + n + '"]');
      for (let i = 0; i < l.length && fields.length < 16; i++) fields.push(l[i]);
    }
  for (const f of fields) f.value = token;
  let callback = null;
  for (const b of boxes) {
    const c = b.getAttribute("data-callback");
    if (c) { callback = c.slice(0, 128); break; }
  }
  return { fields: fields.length, callback };
}`;

/**
 * Inject, part 2, in the page's own world (`this` is its global object): call the widget's
 * callback with the token, as the widget would have. The name comes from `data-callback` (a
 * dotted global name, checked), or for a reCAPTCHA rendered from script, from reCAPTCHA's own
 * client list, searched within fixed bounds. Arguments arrive as values, never as source.
 */
export const CALL_FUNCTION = `function (name, provider, siteKey, token) {
  const NAME = /^[A-Za-z_$][\\w$]*(\\.[A-Za-z_$][\\w$]*){0,3}$/;
  const resolve = (n) => {
    let self = this, f = this;
    for (const k of n.split(".")) { self = f; f = f == null ? undefined : f[k]; }
    return { f, self };
  };
  const call = (f, self) => {
    if (typeof f !== "function") return false;
    try { f.call(self, token); } catch (e) {}
    return true;
  };
  if (typeof name === "string" && NAME.test(name)) {
    const r = resolve(name);
    if (call(r.f, r.self)) return true;
  }
  if (provider !== "recaptcha") return false;
  let clients;
  try { clients = this.___grecaptcha_cfg && this.___grecaptcha_cfg.clients; } catch (e) { return false; }
  if (!clients || typeof clients !== "object") return false;
  let seen = 0;
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 4 || ++seen > 300) return undefined;
    try {
      if (o.sitekey === siteKey && "callback" in o) return o.callback;
      const keys = Object.keys(o).slice(0, 30);
      for (const k of keys) { const r = walk(o[k], depth + 1); if (r !== undefined) return r; }
    } catch (e) {}
    return undefined;
  };
  const ids = Object.keys(clients).slice(0, 8);
  for (const id of ids) {
    const cb = walk(clients[id], 0);
    if (typeof cb === "function") return call(cb, undefined);
    if (typeof cb === "string" && NAME.test(cb)) { const r = resolve(cb); return call(r.f, r.self); }
  }
  return false;
}`;

export interface ProbePage {
  id: string;
  url: string;
  title: string;
}

interface PageState {
  sessionId: string;
  /** What the page looked like (URL, title, frames), and since when. */
  key: string;
  changedAt: number;
  domAt: number;
  signals: PageSignals;
}

const bool = (v: unknown) => v === true;
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max ? v : null;

/** The probe's answer, from a renderer we do not trust: only the expected shapes survive. */
export function readDom(v: unknown): DomSignals {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const widgets: Widget[] = [];
  if (Array.isArray(o.w))
    for (const x of o.w.slice(0, 8) as Record<string, unknown>[]) {
      if (!x || typeof x !== "object") continue;
      const p = x.p;
      if (p !== "recaptcha" && p !== "hcaptcha" && p !== "turnstile") continue;
      const action = str(x.ac, 64);
      const cdata = str(x.cd, 255);
      widgets.push({
        provider: p,
        siteKey: str(x.k, 128),
        callback: str(x.cb, 128),
        invisible: x.s === "invisible",
        ...(action ? { action } : {}),
        ...(cdata ? { cdata } : {}),
      });
    }
  return {
    cloudflare: bool(o.cf),
    perimeterx: bool(o.px),
    geetest: bool(o.gt),
    awsWaf: bool(o.aws),
    widgets,
  };
}

const hasSignal = (d: DomSignals | null) =>
  !!d && (d.cloudflare || d.perimeterx || d.geetest || d.awsWaf);

interface FrameNode {
  frame?: { id?: unknown; url?: unknown; urlFragment?: unknown };
  childFrames?: unknown;
}

/** The frames under a page's main frame, as URLs with their fragment; bounded. */
export function readFrames(tree: unknown): {
  main: string | null;
  urls: string[];
} {
  const root = (tree as { frameTree?: FrameNode } | null)?.frameTree;
  const main = typeof root?.frame?.id === "string" ? root.frame.id : null;
  const urls: string[] = [];
  const walk = (n: FrameNode | undefined, depth: number) => {
    if (!n || depth > 8 || urls.length >= MAX_FRAMES_PER_PAGE) return;
    const kids = Array.isArray(n.childFrames)
      ? (n.childFrames as FrameNode[])
      : [];
    for (const c of kids) {
      if (urls.length >= MAX_FRAMES_PER_PAGE) return;
      const url = typeof c?.frame?.url === "string" ? c.frame.url : "";
      const frag =
        typeof c?.frame?.urlFragment === "string" ? c.frame.urlFragment : "";
      if (url.length + frag.length <= MAX_TARGET_STRING) urls.push(url + frag);
      walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return { main, urls };
}

export class PageProber {
  private cdp: Cdp | null = null;
  private connecting: Promise<Cdp | null> | null = null;
  private pages = new Map<string, PageState>();
  private penalty = new Map<string, number>();
  /** Pages being read when the connection broke: read alone next time, to find the one at fault. */
  private suspects = new Set<string>();
  private closed = false;

  constructor(
    private readonly chromePort: number,
    private readonly log: (msg: string, extra?: object) => void = () =>
      undefined,
    private readonly opts: {
      probeEveryMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private connect(): Promise<Cdp | null> {
    if (this.cdp) return Promise.resolve(this.cdp);
    if (this.closed) return Promise.resolve(null);
    this.connecting ??= (async () => {
      try {
        const { wsUrl } = await getVersion(this.chromePort);
        const cdp = await Cdp.connect(wsUrl, { maxPayload: MAX_PAYLOAD });
        if (this.closed) {
          cdp.close();
          return null;
        }
        cdp.onClose(() => {
          if (this.cdp !== cdp) return;
          this.cdp = null;
          this.pages.clear();
        });
        this.cdp = cdp;
        return cdp;
      } catch (e) {
        this.log("captcha probe could not connect", {
          err: e instanceof Error ? e.message : String(e),
        });
        return null;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  close(): void {
    this.closed = true;
    this.cdp?.close();
    this.cdp = null;
    this.pages.clear();
  }

  private async attach(cdp: Cdp, pageId: string): Promise<string> {
    const { sessionId } = await cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId: pageId, flatten: true },
      undefined,
      CALL_TIMEOUT_MS,
    );
    if (typeof sessionId !== "string") throw new Error("no session");
    return sessionId;
  }

  /**
   * Read each page's frames, and probe the DOM of pages that changed in the last `YOUNG_MS`,
   * have something found or a known frame to look at, or were last probed `PROBE_EVERY_MS` ago.
   */
  async read(
    list: ProbePage[],
    opts: { framed: ReadonlySet<string>; widgets: boolean },
  ): Promise<Map<string, PageSignals>> {
    const out = new Map<string, PageSignals>();
    const now = this.now();
    for (const [id, until] of this.penalty)
      if (until <= now) this.penalty.delete(id);
    const pages = list
      .filter((p) => /^https?:/.test(p.url) && !this.penalty.has(p.id))
      .slice(0, MAX_PROBED_PAGES);
    const cdp = pages.length ? await this.connect() : this.cdp;
    if (!cdp) return out;
    const keep = new Set(pages.map((p) => p.id));
    for (const [id, s] of this.pages)
      if (!keep.has(id)) {
        this.pages.delete(id);
        void cdp
          .send(
            "Target.detachFromTarget",
            { sessionId: s.sessionId },
            undefined,
            CALL_TIMEOUT_MS,
          )
          .catch(() => undefined);
      }
    const one = async (p: ProbePage) => {
      if (this.cdp !== cdp) return; // the connection broke: the rest wait for the next read
      try {
        const s = await this.readPage(cdp, p, opts, now);
        if (s) out.set(p.id, s);
        this.suspects.delete(p.id);
      } catch (e) {
        // Closed, crashed or navigating: forget it, attach afresh next time.
        this.pages.delete(p.id);
        // An answer too large breaks the whole connection, failing every page being read. Read
        // alone, a suspect that breaks it again is left out for a while.
        if (e instanceof Error && /^CDP connection/.test(e.message)) {
          // Drop it now: until its close handshake ends, a socket that refused a message drops
          // whatever is sent on it, and every read would only time out.
          if (this.cdp === cdp) {
            this.cdp = null;
            this.pages.clear();
            cdp.close();
          }
          if (this.suspects.has(p.id)) {
            this.suspects.delete(p.id);
            this.penalty.set(p.id, this.now() + PENALTY_MS);
          } else this.suspects.add(p.id);
        }
      }
    };
    for (const p of pages.filter((x) => this.suspects.has(x.id))) await one(p);
    await Promise.all(pages.filter((x) => !this.suspects.has(x.id)).map(one));
    return out;
  }

  private async readPage(
    cdp: Cdp,
    p: ProbePage,
    opts: { framed: ReadonlySet<string>; widgets: boolean },
    now: number,
  ): Promise<PageSignals | null> {
    let st = this.pages.get(p.id);
    if (!st) {
      st = {
        sessionId: await this.attach(cdp, p.id),
        key: "",
        changedAt: now,
        domAt: 0,
        signals: { frames: [], dom: null },
      };
      this.pages.set(p.id, st);
    }
    const tree = await cdp.send(
      "Page.getFrameTree",
      {},
      st.sessionId,
      CALL_TIMEOUT_MS,
    );
    const { main, urls } = readFrames(tree);
    const key = `${p.url}\n${p.title}\n${urls.join("\n")}`;
    if (key !== st.key) st.changedAt = now;
    const due =
      // Widgets render after load: a page is probed at every read while it is young.
      now - st.changedAt < YOUNG_MS ||
      now - st.domAt >= (this.opts.probeEveryMs ?? PROBE_EVERY_MS) ||
      hasSignal(st.signals.dom) ||
      opts.framed.has(p.id) ||
      urls.some((u) => matchFrame(u) !== null);
    let dom = st.signals.dom;
    if (due && main) {
      const { executionContextId } = await cdp.send<{
        executionContextId: number;
      }>(
        "Page.createIsolatedWorld",
        { frameId: main, worldName: WORLD, grantUniveralAccess: false },
        st.sessionId,
        CALL_TIMEOUT_MS,
      );
      const r = await cdp.send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression: probeExpression(opts.widgets),
          contextId: executionContextId,
          returnByValue: true,
          silent: true,
        },
        st.sessionId,
        CALL_TIMEOUT_MS,
      );
      dom = readDom(r?.result?.value);
      st.domAt = now;
    }
    st.key = key;
    st.signals = { frames: urls, dom };
    return st.signals;
  }

  /**
   * Put a token into a page's widget and call its callback (sessions that solve only). Returns
   * how many response fields were filled and whether a callback was called.
   */
  async inject(
    pageId: string,
    provider: SolvableCaptchaProvider,
    siteKey: string,
    token: string,
  ): Promise<{ fields: number; callback: boolean }> {
    const cdp = await this.connect();
    if (!cdp) throw new Error("the browser is unreachable");
    let sessionId = this.pages.get(pageId)?.sessionId;
    let mine = false;
    if (!sessionId) {
      sessionId = await this.attach(cdp, pageId);
      mine = true;
    }
    try {
      const tree = await cdp.send(
        "Page.getFrameTree",
        {},
        sessionId,
        CALL_TIMEOUT_MS,
      );
      const { main } = readFrames(tree);
      if (!main) throw new Error("no main frame");
      const { executionContextId } = await cdp.send<{
        executionContextId: number;
      }>(
        "Page.createIsolatedWorld",
        { frameId: main, worldName: WORLD, grantUniveralAccess: false },
        sessionId,
        CALL_TIMEOUT_MS,
      );
      const filled = await cdp.send<{ result?: { value?: unknown } }>(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: FILL_FUNCTION,
          executionContextId,
          arguments: [
            { value: provider },
            { value: siteKey },
            { value: token },
          ],
          returnByValue: true,
          silent: true,
        },
        sessionId,
        CALL_TIMEOUT_MS,
      );
      const v = (filled?.result?.value ?? {}) as {
        fields?: unknown;
        callback?: unknown;
      };
      const fields =
        typeof v.fields === "number" && Number.isInteger(v.fields)
          ? v.fields
          : 0;
      const name = str(v.callback, 128);
      // The page's own world: the one step a page can notice (T-57).
      const g = await cdp.send<{ result?: { objectId?: unknown } }>(
        "Runtime.evaluate",
        { expression: "globalThis", returnByValue: false, silent: true },
        sessionId,
        CALL_TIMEOUT_MS,
      );
      const objectId = g?.result?.objectId;
      if (typeof objectId !== "string") return { fields, callback: false };
      try {
        const called = await cdp.send<{ result?: { value?: unknown } }>(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: CALL_FUNCTION,
            objectId,
            arguments: [
              { value: name },
              { value: provider },
              { value: siteKey },
              { value: token },
            ],
            returnByValue: true,
            silent: true,
          },
          sessionId,
          2000,
        );
        return { fields, callback: called?.result?.value === true };
      } finally {
        await cdp
          .send(
            "Runtime.releaseObject",
            { objectId },
            sessionId,
            CALL_TIMEOUT_MS,
          )
          .catch(() => undefined);
      }
    } finally {
      if (mine)
        await cdp
          .send(
            "Target.detachFromTarget",
            { sessionId },
            undefined,
            CALL_TIMEOUT_MS,
          )
          .catch(() => undefined);
    }
  }
}
