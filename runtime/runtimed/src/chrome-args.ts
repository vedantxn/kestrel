import type { Env } from "./config.js";

/**
 * Chrome's command line (R3, R8, R9, R12). Each flag is here for a stated reason; a pure function
 * so the set can be checked in tests and, on the host, against the running process.
 */
export function chromeArgs(
  cfg: Pick<
    Env,
    "KESTREL_PROXY" | "PROFILE_DIR" | "CHROME_PORT" | "CHROME_SANDBOX"
  >,
  size = { width: 1280, height: 800 },
): string[] {
  return [
    // Remote debugging, on localhost only: the CDP forward is what exposes it, behind the session proof.
    `--remote-debugging-port=${cfg.CHROME_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    // A per-session profile directory is required for remote debugging since Chrome 136 (R9).
    `--user-data-dir=${cfg.PROFILE_DIR}`,
    // Never reach the network except through the egress gateway, and remove the loopback bypass, so a
    // page cannot reach Chrome's own debugging port or runtimed on localhost (R8).
    `--proxy-server=${cfg.KESTREL_PROXY}`,
    "--proxy-bypass-list=<-loopback>",
    // No UDP that bypasses the proxy: QUIC off, WebRTC only through the proxy (R9).
    "--disable-quic",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--force-webrtc-ip-handling-policy",
    // The component updater filled a competitor's disk (R9); nothing here should phone home.
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    // The profile is in memory (R13): cap the cache so it cannot eat the session's 2 GB.
    "--disk-cache-size=104857600",
    // First-run prompts off (R9).
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    // The window at the top-left of the virtual display (R3). Configure resizes it to the requested viewport.
    "--window-position=0,0",
    `--window-size=${size.width},${size.height}`,
    ...(cfg.CHROME_SANDBOX === "off" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}
