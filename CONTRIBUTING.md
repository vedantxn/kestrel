# Contributing

Kestrel is finished and in maintenance: bug fixes, documentation and benchmark corrections are welcome; new features are unlikely to be merged. Open an issue first for anything larger than a small fix.

## Setup

```
nvm use          # Node 24
npm ci
npm run check    # format, lint, type-check, tests
```

The tests need Postgres 18 with a database named `*_test` (default `postgresql://kestrel:kestrel@localhost:5432/kestrel_test`). Anything that needs Docker, KVM or Linux networking runs on a Linux host: install Kestrel on one (see the README) and test there.

## Rules

Read [`AGENTS.md`](AGENTS.md); the same rules apply to people. In short:

- Components talk only through `packages/contracts`. A contract change goes in its own commit, bumps `CONTRACTS_VERSION`, and regenerates `docs/api/openapi.json` with `npm run openapi`.
- Anything read back from a session container is hostile input and is checked with a schema.
- Every connection to an address a caller chose goes through the egress gateway.
- Tests sit beside the code as `*.test.ts`.

Security problems go through [`SECURITY.md`](SECURITY.md), not issues.
