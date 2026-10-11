<p align="center">
  <img src=".github/assets/logo.svg" width="64" alt="">
</p>

<h1 align="center">Kestrel</h1>

<p align="center">
  <b>Isolated Chrome for your agents, on a machine you own.</b>
</p>

<p align="center">
  Open-source cloud browsers for AI agents. One API call returns a CDP URL for Playwright, Puppeteer or any agent.<br>
  Every browser runs in its own Firecracker microVM, and the only way out is an egress gateway you control.
</p>

<p align="center">
  <a href="https://kestrel-browsers.vercel.app">Website</a> ·
  <a href="https://kestrel-browsers.vercel.app/docs">Docs</a> ·
  <a href="https://kestrel-browsers.vercel.app/docs/quickstart">Quickstart</a> ·
  <a href="#how-fast">Benchmarks</a> ·
  <a href="https://kestrel-browsers.vercel.app/docs/security">Threat model</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-b4441c"></a>
  <img alt="v1.0.0" src="https://img.shields.io/badge/release-v1.0.0-b4441c">
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/hero-dark.png">
  <img alt="A Kestrel session: the agent's calls on the left, the live browser on the right, where a CAPTCHA has been detected and a person has taken control." src=".github/assets/hero-light.png">
</picture>

**Status:** v1.0.0, finished and in maintenance (bug fixes, docs and benchmark corrections). Licensed under [Apache-2.0](LICENSE).

## What it does

- **Sessions:** a fresh Chrome per session, reached over `wss://` (Playwright, Puppeteer, any CDP client), with timeouts, viewport, allow and deny lists, and bring-your-own upstream proxies.
- **Watching and helping:** live view and human takeover in the browser, recording to MP4, a screenshot-and-input HTTP endpoint for computer-use agents, and CAPTCHA detection that tells your agent when to hand over.
- **Logged-in state:** profiles save cookies, `localStorage` and IndexedDB from one session and restore them in the next, encrypted at rest.
- **For agents:** TypeScript and Python SDKs, a CLI, a hosted MCP server at `/mcp`, and [`llms.txt`](https://kestrel-browsers.vercel.app/llms.txt) with docs written for coding agents.
- **For operators:** a dashboard (sessions, keys, usage, nodes), a written [threat model](https://kestrel-browsers.vercel.app/docs/security), and one-command install.

## How fast

A whole session (create, connect over CDP, load `example.com`, release), end to end, in ms. Lower is better; sorted by p95, the wait an agent feels on a slow day.

| Provider     | [Browser Arena](https://github.com/nottelabs/browserarena), one at a time<br>p50 / **p95** / p99 | [ComputeSDK](https://github.com/computesdk/benchmarks) lifecycle<br>p50 / **p95** / p99 |
| ------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Kestrel**  | **244 / 286 / 323**                                                                              | **247 / 292 / 340**                                                                     |
| Kernel       | 335 / 508 / 546                                                                                  | 297 / 495 / 571                                                                         |
| Browser Use  | 513 / 662 / 734                                                                                  | 565 / 706 / 782                                                                         |
| Notte        | 465 / 741 / 1,195                                                                                | 2,768 / 5,274 / 9,117                                                                   |
| Lightpanda   | 788 / 840 / 942                                                                                  | not tested                                                                              |
| Hyperbrowser | 860 / 929 / 1,264                                                                                | 669 / 745 / 799                                                                         |
| Browserbase  | 928 / 1,020 / 1,029                                                                              | 911 / 1,083 / 1,310                                                                     |
| Anchor       | 3,113 / 5,014 / 5,633                                                                            | not tested                                                                              |
| Steel        | 4,612 / 5,843 / 6,260                                                                            | 2,577 / 3,778 / 6,361                                                                   |

Kestrel ran on one m7i.2xlarge with one microVM node, from a runner in the same AWS region (2026-10-05, one round; method and raw data in [`docs/results/cycle-final`](https://kestrel-browsers.vercel.app/docs/benchmarks)). Hyperbrowser is three rounds from the same runner the day before. The other providers' figures are recomputed, per session and with the same percentiles, from each harness's own runs: Browser Arena on 2026-10-10 and ComputeSDK on 2026-10-09.

Each browser is restored from a Firecracker memory snapshot: about 7.7 new browsers a second on one host, 2.9 times Docker on the same host.

## Snapshot clones share nothing

Restoring many browsers from one memory snapshot is fast, but every clone starts with the same memory, including the state of every random number generator. Kestrel's clones are checked for that: the kernel is reseeded on restore (VMGenID), and each session's page is made after the restore so V8's `Math.random` is seeded fresh. [`snapshot-entropy-check`](bench/entropy) reads `Math.random`, `crypto.getRandomValues`, `randomUUID`, WebCrypto keys and TLS ClientHellos from many sessions and fails if any value repeats. It works against any provider that gives you a CDP URL:

```
npx snapshot-entropy-check --kestrel https://your-kestrel --key ksl_... --n 20
npx snapshot-entropy-check --cdp wss://browser-1/... --cdp wss://browser-2/...
```

## Install

On one x86_64 Linux machine (Ubuntu 22.04/24.04, Debian 12/13 or Amazon Linux 2023) with 4 CPUs and 8 GiB or more. With `/dev/kvm` and 16 GiB, browsers run as microVMs; otherwise as Docker containers.

```
# On a trusted network (no TLS; http:// and ws://):
curl -fsSL https://raw.githubusercontent.com/vedantxn/kestrel/v1.0.0/install.sh | sudo bash -s -- --version v1.0.0 --local

# On the internet, with TLS (ports 80, 443 and 8443 open):
curl -fsSL https://raw.githubusercontent.com/vedantxn/kestrel/v1.0.0/install.sh | sudo bash -s -- --version v1.0.0 --hostname kestrel.example.com
#   no domain? --sslip uses <your-ip>.sslip.io
```

It checks the machine first and says what is missing, then prepares Docker and the data volume, pulls the images, starts everything, makes one test session and prints the dashboard URL and an admin API key. Re-running it upgrades in place. Options: `install.sh --help`. On AWS, Terraform can make the host for you: [`docs/runbook-aws-setup.md`](https://kestrel-browsers.vercel.app/docs/install).

Not supported: arm64 hosts (so no Apple-silicon VMs), macOS or Windows hosts, more than one machine, stealth or fingerprint changes, and CAPTCHA solving.

## First session

```python
# pip install 'kestrel-browser[playwright]'   (KESTREL_URL and KESTREL_API_KEY set)
from kestrel_browser import Kestrel

with Kestrel().connect() as kb:
    page = kb.browser.contexts[0].pages[0]
    page.goto("https://example.com")
    print(page.title())
```

```ts
// npm i @kestrel/sdk playwright-core
import { Kestrel } from "@kestrel/sdk";

const { browser, close } = await new Kestrel().connect();
const page = browser.contexts()[0]!.pages()[0]!;
await page.goto("https://example.com");
console.log(await page.title());
await close();
```

More: the [quickstart](https://kestrel-browsers.vercel.app/docs/quickstart), [MCP](https://kestrel-browsers.vercel.app/docs/mcp), [profiles](https://kestrel-browsers.vercel.app/docs/profiles), [live view and computer use](https://kestrel-browsers.vercel.app/docs/live-view-and-computer), and recipes for [browser-use](https://kestrel-browsers.vercel.app/docs/recipes/browser-use), [Stagehand](https://kestrel-browsers.vercel.app/docs/recipes/stagehand) and [Playwright MCP](https://kestrel-browsers.vercel.app/docs/recipes/playwright-mcp).

## Check it yourself

- **Any deployment, from outside:** `bin/verify <url> <api key>` runs real Playwright and Puppeteer through the gateway and the entropy check on ten sessions.
- **On the host:** `sudo infra/host/bench.sh m1` runs the exit checks: lifecycles, isolation probes, chaos cases (killed processes, a killed VMM) and the clone comparison.
- **Browser Arena and ComputeSDK:** the adapters in [`bench/adapters`](bench/adapters/README.md) add Kestrel to both harnesses unmodified; `bench/adapters/tail.py` turns their raw output into Kestrel's rows above.

## How it is built

- [Security and the threat model](https://kestrel-browsers.vercel.app/docs/security)
- [HTTP API (OpenAPI)](packages/contracts/openapi.json)
- [Benchmarks and how they were measured](https://kestrel-browsers.vercel.app/docs/benchmarks)

## Development

```
nvm use          # Node 24
npm ci
npm run check    # format, lint, type-check, tests (needs Postgres 18: see CONTRIBUTING.md)
npm run openapi  # regenerate packages/contracts/openapi.json from the contracts
npm run test:py  # the Python SDK's tests (packages/sdk-py; needs uv)
```

Anything needing Docker, KVM or Linux networking runs on a Linux host. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

### The dashboard on your machine

The dashboard (`apps/web`, pages in `packages/dashboard`) talks to the API like any client. To build it without browser nodes, run the API against a seeded database:

```
createdb kestrel_dev
DATABASE_URL=postgresql://kestrel:kestrel@localhost:5432/kestrel_dev npm run db:migrate
DATABASE_URL=postgresql://kestrel:kestrel@localhost:5432/kestrel_dev npm run seed:demo -w @kestrel/api   # prints an admin key
# start the API (see apps/api/src/config.ts for its environment), then:
KESTREL_API_URL=http://127.0.0.1:8080 npm run dev:web    # http://localhost:3000, sign in with the key
```
