/**
 * A TLS ClientHello's per-connection values: the 32-byte random, the legacy session id, the server
 * name, and each key share's public key. Two browsers that share random state (a snapshot clone
 * whose generator was not reseeded) send the same ones.
 */
export interface ClientHello {
  random: string;
  sessionId: string;
  sni: string | null;
  keyShares: string[];
}

/**
 * Parse the first handshake message from the start of a TLS stream. Returns null until `buf` holds
 * a whole message (it may span several records), and throws when the stream is not a ClientHello.
 */
export function parseClientHello(buf: Buffer): ClientHello | null {
  // Records: type(1) version(2) length(2) body. Join the handshake records' bodies.
  let hs = Buffer.alloc(0);
  let at = 0;
  while (at + 5 <= buf.length) {
    if (buf[at] !== 22) throw new Error("not a TLS handshake");
    const len = buf.readUInt16BE(at + 3);
    if (at + 5 + len > buf.length) break;
    hs = Buffer.concat([hs, buf.subarray(at + 5, at + 5 + len)]);
    at += 5 + len;
    if (hs.length >= 4 && hs.length >= 4 + hs.readUIntBE(1, 3)) break;
  }
  if (hs.length < 4) return null;
  if (hs[0] !== 1) throw new Error("not a ClientHello");
  const msgLen = hs.readUIntBE(1, 3);
  if (hs.length < 4 + msgLen) return null;
  const m = hs.subarray(4, 4 + msgLen);

  let p = 2; // legacy_version
  const random = m.subarray(p, p + 32).toString("hex");
  p += 32;
  const sidLen = m[p] as number;
  const sessionId = m.subarray(p + 1, p + 1 + sidLen).toString("hex");
  p += 1 + sidLen;
  p += 2 + m.readUInt16BE(p); // cipher suites
  p += 1 + (m[p] as number); // compression methods
  let sni: string | null = null;
  const keyShares: string[] = [];
  if (p + 2 <= m.length) {
    const end = p + 2 + m.readUInt16BE(p);
    p += 2;
    while (p + 4 <= end) {
      const type = m.readUInt16BE(p);
      const len = m.readUInt16BE(p + 2);
      const ext = m.subarray(p + 4, p + 4 + len);
      if (type === 0 && ext.length >= 5) {
        // server_name: list length(2), then type(1) length(2) name.
        const nameLen = ext.readUInt16BE(3);
        sni = ext.subarray(5, 5 + nameLen).toString("latin1");
      } else if (type === 51 && ext.length >= 2) {
        // key_share: list length(2), then group(2) length(2) key_exchange.
        let q = 2;
        while (q + 4 <= ext.length) {
          const group = ext.readUInt16BE(q);
          const kl = ext.readUInt16BE(q + 2);
          // GREASE groups carry a single placeholder byte; they say nothing about randomness.
          if ((group & 0x0f0f) !== 0x0a0a)
            keyShares.push(ext.subarray(q + 4, q + 4 + kl).toString("hex"));
          q += 4 + kl;
        }
      }
      p += 4 + len;
    }
  }
  return { random, sessionId, sni, keyShares };
}
