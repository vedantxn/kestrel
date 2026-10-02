import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@kestrel/shared";

export interface TlsMaterial {
  cert: string;
  key: string;
}

/** Read cert.pem and key.pem from a directory and check they belong together (G16). Null if absent or mismatched. */
export function readTlsDir(dir: string, log?: Logger): TlsMaterial | null {
  try {
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const key = readFileSync(join(dir, "key.pem"), "utf8");
    if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) {
      log?.warn(
        "the certificate and key in the TLS directory do not match; ignoring them",
      );
      return null;
    }
    return { cert, key };
  } catch {
    return null;
  }
}

/**
 * W2. The gateway terminates its own TLS from a copy of Caddy's certificate that the node agent
 * maintains. Waits, with retries, until one exists; then calls `apply` again whenever the files
 * change, so a renewal needs no restart.
 */
export class TlsWatcher {
  private timer: NodeJS.Timeout | undefined;
  private fingerprint = "";

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    private readonly pollMs = 10_000,
  ) {}

  private stamp(): string {
    try {
      return `${statSync(join(this.dir, "cert.pem")).mtimeMs}:${statSync(join(this.dir, "key.pem")).mtimeMs}`;
    } catch {
      return "";
    }
  }

  /** Resolve with the first usable material, polling until there is some. */
  async waitForFirst(): Promise<TlsMaterial> {
    let warned = 0;
    for (;;) {
      const m = readTlsDir(this.dir, this.log);
      if (m) {
        this.fingerprint = this.stamp();
        return m;
      }
      if (Date.now() - warned > 30_000) {
        this.log.warn({ dir: this.dir }, "waiting for a TLS certificate");
        warned = Date.now();
      }
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, 2_000)));
    }
  }

  watch(apply: (m: TlsMaterial) => void): void {
    this.timer = setInterval(() => {
      const s = this.stamp();
      if (!s || s === this.fingerprint) return;
      const m = readTlsDir(this.dir, this.log);
      if (!m) return;
      this.fingerprint = s;
      apply(m);
      this.log.info("TLS certificate reloaded");
    }, this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
