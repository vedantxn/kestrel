# snapshot-entropy-check

Do these cloud browsers share random state?

Fast cloud browsers are often restored from a memory snapshot of a browser that was already running. Every clone then starts with the same memory, including the state of each random number generator, unless something reseeds it. Two sessions that share that state can produce the same `Math.random()` sequence, the same `crypto.randomUUID()`, the same WebCrypto keys, or the same TLS ClientHello randoms and key shares, which lets sites link them and can weaken what the randomness protects.

This tool reads those values from many browsers and fails if any value appears twice.

```
npx snapshot-entropy-check --kestrel https://your-kestrel --key ksl_... --n 20
npx snapshot-entropy-check --cdp wss://browser-1/... --cdp wss://browser-2/... --cdp wss://browser-3/...
npx snapshot-entropy-check --cdp-cmd "./new-session.sh" --n 20     # any provider: print a CDP URL per run
```

## What it reads

From each browser's page as it was handed over, and again from a page it loads (`--page`, default `https://example.com`, which runs in a new renderer):

- four `Math.random()` values (V8's generator, seeded in the renderer process);
- 16 bytes of `crypto.getRandomValues` and a `crypto.randomUUID()` (the kernel's generator, through Chrome);
- the public half of a fresh WebCrypto ECDH P-256 key.

With `--tls-ip <this machine's public IPv4>` (and root, to listen on port 443), each browser also opens two connections to `<name>.<ip>.sslip.io`, a name of its own, where a listener reads the TLS ClientHello's random, legacy session id and key shares, then closes the connection. `--tls-domain` uses your own wildcard domain instead of sslip.io.

It also reports the largest difference between a browser's clock and this machine's, since a restored clone can keep the snapshot's time.

## Reading the result

```
item                                values  shared
first page: Math.random                 80  no
loaded page: crypto.randomUUID          20  no
TLS ClientHello random                  40  no
...
PASS: 20 browsers, nothing shared.
```

Any `YES` names the value and the sessions that shared it. A shared `Math.random` but unique `getRandomValues` means the kernel was reseeded (for example by VMGenID) but a renderer process that existed in the snapshot kept V8's state; a shared ClientHello random means the kernel's generator was not reseeded at all.

Exit status: 0 nothing shared, 1 something shared (or fewer than two browsers observed), 2 usage error. `--json FILE` keeps every observation.

Part of [Kestrel](https://github.com/vedantxn/kestrel), whose snapshot clones it was written to check. Apache-2.0.
