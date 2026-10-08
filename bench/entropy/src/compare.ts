import type { ClientHello } from "./hello.js";

/** What one page's scripts can read from its random sources. */
export interface PageRandom {
  /** Four Math.random() values in a row. */
  math: number[];
  /** crypto.getRandomValues of 16 bytes, hex. */
  grv: string;
  uuid: string | null;
  /** A fresh WebCrypto ECDH P-256 public key, hex; null where WebCrypto is unavailable. */
  ecdh: string | null;
}

export interface SessionObservation {
  label: string;
  /** The session's page as it was handed over, before it loads anything. */
  first: PageRandom;
  /** A page the session loaded (a new renderer for a new site); null if none was asked for. */
  page: PageRandom | null;
  /** The browser's clock minus this machine's, in ms. */
  skewMs: number;
  /** ClientHellos the session sent to the recorder; empty when the TLS check is off. */
  hellos: ClientHello[];
  error?: string;
}

export interface Collision {
  value: string;
  sessions: string[];
}

export interface ItemResult {
  item: string;
  values: number;
  collisions: Collision[];
}

export interface Report {
  pass: boolean;
  sessions: number;
  items: ItemResult[];
  maxAbsSkewMs: number | null;
}

/**
 * Every value should appear once. Anything that appears twice, in two sessions or twice in one,
 * means two generators were in the same state: what a snapshot clone without a reseed produces.
 */
export function compare(obs: SessionObservation[]): Report {
  const ok = obs.filter((o) => !o.error);
  const items = new Map<
    string,
    Map<string, { n: number; sessions: Set<string> }>
  >();
  const count = (item: string, value: string | null, who: string) => {
    if (value === null || value === "") return;
    let m = items.get(item);
    if (!m) items.set(item, (m = new Map()));
    const v = m.get(value) ?? { n: 0, sessions: new Set<string>() };
    v.n += 1;
    v.sessions.add(who);
    m.set(value, v);
  };
  for (const o of ok) {
    for (const [where, r] of [
      ["first page", o.first],
      ["loaded page", o.page],
    ] as const) {
      if (!r) continue;
      for (const m of r.math)
        count(`${where}: Math.random`, String(m), o.label);
      count(`${where}: crypto.getRandomValues`, r.grv, o.label);
      count(`${where}: crypto.randomUUID`, r.uuid, o.label);
      count(`${where}: WebCrypto ECDH key`, r.ecdh, o.label);
    }
    for (const h of o.hellos) {
      count("TLS ClientHello random", h.random, o.label);
      count("TLS legacy session id", h.sessionId, o.label);
      for (const k of h.keyShares) count("TLS key share", k, o.label);
    }
  }
  const results: ItemResult[] = [...items.entries()].map(([item, m]) => ({
    item,
    values: [...m.values()].reduce((a, v) => a + v.n, 0),
    collisions: [...m.entries()]
      .filter(([, v]) => v.n > 1)
      .map(([value, v]) => ({ value, sessions: [...v.sessions].sort() })),
  }));
  results.sort((a, b) => a.item.localeCompare(b.item));
  const skews = ok.map((o) => Math.abs(o.skewMs));
  return {
    pass:
      ok.length >= 2 &&
      ok.length === obs.length &&
      results.every((r) => r.collisions.length === 0),
    sessions: ok.length,
    items: results,
    maxAbsSkewMs: skews.length ? Math.max(...skews) : null,
  };
}
