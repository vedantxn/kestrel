import { z } from "zod";
import { SessionProof } from "./tokens.js";
import { Timezone } from "./geo.js";
import { Viewport } from "./session.js";

/**
 * C5 (drafted; the browser-runtime plan finalises it). The control API `runtimed` serves
 * inside each container on port 9000, called only by the node agent, authenticated by a
 * per-container bearer token the agent chose when it created the container.
 *
 * Everything in the container is untrusted (principle 2): the agent treats every response
 * as hostile input and validates it against these schemas.
 *
 * Ports inside the container:
 *   9222  Chrome's debugging port, localhost only
 *   9223  CDP forward: requires `x-kestrel-session-proof`, then passes bytes through untouched
 *   9000  this control API
 */
export const RUNTIME_PROTOCOL_VERSION = 1;
export const RUNTIME_PORTS = {
  chrome: 9222,
  cdpForward: 9223,
  control: 9000,
} as const;

export const RUNTIME_PATHS = {
  /** `?wait=<ms>` (at most 10 s) holds the answer until the browser is ready or failed. */
  health: "/health",
  configure: "/configure",
  /** W4: one `/computer` action on the page live view shows. */
  computer: "/computer",
  /** W3: finish the recording so its last fragment is written; the agent calls it before removal. */
  recordingStop: "/recording/stop",
  /**
   * W3 in a microVM (`recordingSink: "pull"`, docs/lld/microvm-recording.md). `GET ?after=<seq>`:
   * the completed fragments after `seq`, oldest first, as one binary body described by the
   * `x-kestrel-recording` header (`RecordingFragments`). Asking for `after=N` also acknowledges
   * every fragment up to N, which the guest then frees. 404 when this browser has no pull sink.
   */
  recordingFragments: "/recording/fragments",
  /**
   * V7. A browser restored from a snapshot starts with the template's control token, the same in
   * every clone: the agent replaces it with the container's own before anything else. Accepted
   * once, authenticated by the template token; the template token is refused from then on.
   */
  rekey: "/rekey",
  /**
   * `GET`: the CAPTCHAs present now (`RuntimeCaptcha`, in captcha.ts). 409 before configure; a
   * `runtimed` from before CAPTCHA detection answers 404, which means not supported.
   */
  captcha: "/captcha",
  /**
   * `POST` (`ProbeRequest`), only on a clone re-keyed with `probe: true` (the harness's probe VM,
   * threat model G-23): raw connections from inside the guest. 404 on every other browser.
   */
  probe: "/probe",
  /**
   * `GET`: what a solver needs (`RuntimeCaptchaChallenges`), answered only once configured with
   * `captchaSolve` (409 otherwise). An older `runtimed` answers 404.
   */
  captchaChallenges: "/captcha/challenges",
  /** `POST` a `CaptchaInjectRequest`: put the token in the page (`RuntimeCaptchaInject`). */
  captchaInject: "/captcha/inject",
} as const;

/** `GET /health`. A pooled container is "hot" only when this says `ready`. */
export const RuntimeHealth = z.object({
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  status: z.enum(["starting", "ready", "failed"]),
  /** Chrome's debugging port answered. */
  chromeReady: z.boolean(),
  chromeVersion: z.string().nullable(),
});
export type RuntimeHealth = z.infer<typeof RuntimeHealth>;

/**
 * `POST /configure`: bind a pooled browser to a session. Idempotent for the same proof, and
 * refused with 409 if the container was already configured with a different one. Doubles as
 * the health check that gates a start (G7): a browser that cannot apply it never gets a route.
 */
export const ConfigureRequest = z.object({
  sessionProof: SessionProof,
  viewport: Viewport,
  /** W3. Start recording the display once configured. */
  recording: z.boolean().default(false),
  /**
   * Where the recording goes. `volume`: a file in the recording volume the agent mounted at
   * RECORDING_DIR (a container). `pull`: fragments held in the guest's memory until the agent
   * pulls them (`GET /recording/fragments`), for a microVM, which has no volume. A runtimed from
   * before this field ignores it and records only to a volume.
   */
  recordingSink: z.enum(["volume", "pull"]).default("volume"),
  /** Override the time zone every page, frame and worker sees, for the session's life. */
  timezone: Timezone.optional(),
  /**
   * The session solves CAPTCHAs (`docs/lld/captcha.md`): runtimed answers `/captcha/challenges`
   * and `/captcha/inject`. Without it, nothing of a page's URL or site keys leaves runtimed.
   */
  captchaSolve: z.boolean().default(false),
});
export type ConfigureRequest = z.infer<typeof ConfigureRequest>;

export const ConfigureResponse = z.object({
  /** What the page actually measures, so the agent can verify the viewport took effect (A6). */
  viewport: Viewport,
  deviceScaleFactor: z.number().positive(),
  chromeVersion: z.string(),
  /**
   * The time zone override in force, or null for none. A `runtimed` from before time zones
   * leaves it out, and the agent then does not use it for a session that asked for one.
   */
  timezone: z.string().max(64).nullable().optional(),
});
export type ConfigureResponse = z.infer<typeof ConfigureResponse>;

/**
 * `POST /rekey` (V7, microVM clones only). After the token is replaced, runtimed also gives the
 * session a page made after the restore, in a new renderer: a renderer copied from the snapshot
 * would share its JavaScript random state with every other clone.
 */
export const RekeyRequest = z
  .object({
    token: z.string().regex(/^[0-9a-f]{32,128}$/),
    /**
     * The harness's probe VM (G-23): this clone never becomes a session. It refuses `/configure`
     * and serves `/probe`. Sent only by an agent whose harness surface is on (KESTREL_HARNESS=on,
     * docs/harness.md); a runtimed from before it refuses the field.
     */
    probe: z.literal(true).optional(),
  })
  .strict();
export type RekeyRequest = z.infer<typeof RekeyRequest>;

export const RekeyResponse = z.object({ ok: z.literal(true) });
export type RekeyResponse = z.infer<typeof RekeyResponse>;

/**
 * `POST /probe` (G-23). Each target is one attempt from inside the guest, with no proxy: a TCP
 * connection (optionally sending bytes and reading the first line of the answer), or a DNS query
 * over UDP. What a probe reports is read back from a guest, so the agent and the harness validate
 * it like any other answer from a browser.
 */
export const ProbeTarget = z.strictObject({
  name: z.string().min(1).max(200),
  /** An address literal: the probe never resolves a name. */
  host: z
    .string()
    .max(64)
    .regex(/^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:.]+)$/i),
  port: z.number().int().min(1).max(65535),
  proto: z.enum(["tcp", "udp-dns"]).default("tcp"),
  /** TCP only: written once connected (latin1); the first line of the answer is returned. */
  send: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(100).max(10_000).default(3000),
});
export type ProbeTarget = z.input<typeof ProbeTarget>;

export const ProbeRequest = z.strictObject({
  targets: z.array(ProbeTarget).min(1).max(64),
});
export type ProbeRequest = z.input<typeof ProbeRequest>;

export const ProbeResult = z.strictObject({
  name: z.string().max(200),
  /** "connected", "answered" (a DNS reply came back), "timeout", or an error code (ECONNREFUSED, ...). */
  result: z.string().max(64),
  /** The first line of what came back after `send`. */
  head: z.string().max(512).optional(),
  /** The `x-kestrel-egress-denied` reason, if the answer carried one. */
  denied: z.string().max(64).nullable().optional(),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

export const ProbeResponse = z.strictObject({
  results: z.array(ProbeResult).max(64),
});
export type ProbeResponse = z.infer<typeof ProbeResponse>;

/**
 * The module interface (drafted). `runtimed` has a small core (launch and supervise Chrome and
 * the display, forward CDP, report health) and modules owned by later plans (live view,
 * recording, downloads, profiles, stealth). A module may add routes to the control API and
 * hooks around Chrome's launch; it must not change the core's behaviour.
 */
export interface RuntimeModule {
  readonly name: string;
  /** Extra command-line flags for Chrome. */
  chromeArgs?(): string[];
  /** Called after Chrome's debugging port answers and before the container reports ready. */
  onChromeReady?(ctx: { cdpPort: number }): Promise<void>;
  /** Called when the session is configured. */
  onConfigure?(req: ConfigureRequest): Promise<void>;
  stop?(): Promise<void>;
}

/** W3. Where the recording volume is mounted in the container, and the file the recorder writes. */
export const RECORDING_DIR = "/artifacts";
export const RECORDING_FILE = "recording.mp4";
export const RECORDING_LIMITS = {
  /** The volume's quota; the recorder stops itself a little before it. */
  volumeBytes: 600 * 1024 * 1024,
  fileBytes: 580 * 1024 * 1024,
  framerate: 10,
  /** Kept on the node this long after the session ends. */
  retentionMs: 24 * 60 * 60_000,
  /**
   * The pull sink (microVMs). A fragment, and so any one box in it, is at most this: the recorder
   * cuts fragments at 4 MiB (`-frag_size`), and one frame more is well under the rest.
   */
  fragmentBytes: 8 * 1024 * 1024,
  /** One `GET /recording/fragments` answer carries at most this many bytes, and fragments. */
  pullBytes: 8 * 1024 * 1024,
  pullFragments: 64,
  /**
   * Completed fragments the guest holds for the agent. Past this it stops reading the encoder,
   * which then drops frames (the video freezes) instead of the guest running out of memory.
   */
  guestBufferBytes: 32 * 1024 * 1024,
} as const;

/** The response header describing a `GET /recording/fragments` body. */
export const RECORDING_FRAGMENTS_HEADER = "x-kestrel-recording";

/**
 * What the `x-kestrel-recording` header holds: the fragments in the body, in order and back to
 * back, and whether the recording has ended with nothing left after them. Hostile input to the
 * agent, which also checks that the sequence numbers follow on from what it asked for, that the
 * sizes add up to the body, and every fragment's boxes (`checkMp4Fragment`).
 */
export const RecordingFragments = z
  .object({
    state: z.enum(["idle", "recording", "stopped", "failed"]),
    fragments: z
      .array(
        z
          .object({
            seq: z.number().int().positive(),
            bytes: z
              .number()
              .int()
              .positive()
              .max(RECORDING_LIMITS.fragmentBytes),
          })
          .strict(),
      )
      .max(RECORDING_LIMITS.pullFragments),
    done: z.boolean(),
  })
  .strict();
export type RecordingFragments = z.infer<typeof RecordingFragments>;
