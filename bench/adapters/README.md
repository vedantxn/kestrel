# Public benchmark adapters

Kestrel providers for two public cloud-browser benchmarks, so Kestrel runs on their unmodified harnesses next to the hosted vendors (HLD 13.3). Each folder has the provider file and an installer. The installer clones the upstream repo at the commit the adapter was tested against, adds the provider and registers it. Running it twice changes nothing, and the diff it leaves is the pull request to send upstream.

| Benchmark                                             | Upstream                                                            | Pinned commit | What Kestrel adds                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser Arena                                         | [nottelabs/browserarena](https://github.com/nottelabs/browserarena) | `c900b9d`     | `src/providers/kestrel.ts` (a `ProviderClient`), and registration in `types.ts`, `providers/index.ts`, `.env.example`                                                                                             |
| ComputeSDK browser benchmarks (lifecycle, throughput) | [computesdk/benchmarks](https://github.com/computesdk/benchmarks)   | `24922f2`     | `benchmarks/browser/kestrel-provider.ts` (the `@computesdk/<provider>` shape: `session.create`, `session.destroy`), entries in `providers.ts` and `throughput-providers.ts`, and a `bench:browser:kestrel` script |

Both adapters make two HTTP calls with no SDK: `POST /v1/sessions` returns once the browser is ready, with a `wss://` `connectUrl`, and `POST /v1/sessions/{id}/stop` releases it. Both read `KESTREL_URL` (the deployment's public URL) and `KESTREL_API_KEY`.

## Running

```sh
export KESTREL_URL=https://<your deployment> KESTREL_API_KEY=ksl_...

# Browser Arena
node bench/adapters/browserarena/install.mjs ../browserarena
cd ../browserarena && npm install && npm run bench -- --provider=kestrel --runs=100
#   at 10 concurrent: add --concurrency=10

# ComputeSDK (a pnpm workspace; --no-ingest runs locally without a ComputeSDK platform account)
node bench/adapters/computesdk/install.mjs ../computesdk-benchmarks
cd ../computesdk-benchmarks && npx pnpm@10.33.0 install --frozen-lockfile
npx tsx packages/benchsdk-runner/dist/bin.js run benchmarks/browser/browser.bench.ts --provider kestrel --iterations 25 --no-ingest
npx tsx packages/benchsdk-runner/dist/bin.js run benchmarks/browser/browser-throughput.bench.ts --provider kestrel --no-ingest
```

For comparable numbers, run from a machine in the deployment's region (us-east-1). Re-run the hosted vendors from the same machine on the same day (HLD 13.3).

## Deviations from the other providers, and why

- **Viewport (ComputeSDK throughput):** that benchmark asks every provider for a 1920x1080 page. Kestrel's page can be at most 1920x1000, because the 1920x1080 virtual display also holds Chrome's toolbar, so the adapter clamps to 1920x1000. Screenshots are then about 7% smaller than other providers'.
- **Unknown options:** options other providers take (`stealth`, `region`, `proxies`, `headless`) are dropped before the request. Kestrel refuses unknown options rather than ignoring them. Kestrel has no stealth mode or region choice, so dropping them changes nothing.
- **Cost (Browser Arena `computeCost`):** Kestrel is self-hosted, so it reports infrastructure cost at stated density rather than a list price: an m7i.2xlarge at $0.4032/h running 12 sessions, billed per second. Override it with `KESTREL_COST_PER_HOUR`.

## Verified (2026-10-03)

Both harnesses type-check with the adapter (0 errors). Each ran against a Kestrel deployment on one m7i-flex.xlarge in us-east-1, from a laptop far from us-east-1. The timings therefore include about 250 ms of round-trip time per network exchange and are **not** benchmark results; they only show the adapters work end to end.

| Run                                  | Result                 | Medians from far away (not comparable)                               |
| ------------------------------------ | ---------------------- | -------------------------------------------------------------------- |
| Browser Arena hello-browser, 10 runs | 10/10 success          | create 315, connect 1,556, navigate 431, release 230 ms              |
| ComputeSDK lifecycle, 10 iterations  | 10/10 success          | create 315, connect 1,559, navigate 431, release 226, total 2,908 ms |
| ComputeSDK throughput, 1 session     | success, 10/10 actions | (dominated by the distance)                                          |

Real numbers, from a runner in us-east-1 against Kestrel and Hyperbrowser on the same day: `docs/results/public-2026-10-03/`. To make a runner: `bin/tf main apply -var enable_runner=true`, then `KESTREL_TARGET=runner bin/host ...`, `run-public.sh` and `summarize.py`. Destroy it afterwards by applying without the variable.
