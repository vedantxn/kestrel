# Kestrel: notes for agents

Kestrel is an open-source cloud browser platform for AI agents. It is finished (v1.0.0) and in maintenance: bug fixes, documentation and benchmark corrections only, no new features. Read `docs/HLD.md` (architecture), `docs/STATUS.md` (what exists) and `docs/v1-plan.md` (how it was built, and section 8's differences from the HLD) before changing anything. Decisions are in `docs/adr/`; the threat model is `docs/threat-model.md`.

## Rules

- **Contracts first.** Components talk only through `packages/contracts`. Change a contract in its own commit, say which consumers it affects, and bump `CONTRACTS_VERSION`. Run `npm run openapi` after changing a public schema; CI fails if `packages/contracts/openapi.json` is stale.
- **Everything inside a session container is untrusted.** Anything read back from one is hostile input and is validated with a schema.
- **Every connection to an address a caller chose goes through the egress gateway.**
- **State changes are conditional updates** ("set to X only if currently Y") and write an event.
- **Differences from the HLD are listed in `docs/v1-plan.md` section 8.** Nothing else may differ without adding a row there.

## Working

- Node 24, TypeScript strict, npm workspaces (`packages/*`, `apps/*`). Tests sit beside the code as `*.test.ts` (Vitest).
- `npm run check` runs format, lint, type-check and tests. Run it before committing.
- The API's tests use a real Postgres 18 (`brew install postgresql@18`): `DATABASE_URL` defaults to `postgresql://kestrel:kestrel@localhost:5432/kestrel_test`, and the run refuses any database not named `*_test`. Migrations are applied automatically at the start of a run.
- Small commits as each piece works. The maintainer commits straight to `main`; contributors open a pull request, which CI checks. Run `npm run build`, lint and the tests locally first.
- Anything needing Docker or Linux networking runs on a Linux host (your own install, or the AWS host through `bin/host`), not on macOS.
- Secrets never go in the repo, in images or in Terraform state.
