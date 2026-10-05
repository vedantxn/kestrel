# Kestrel

Open-source, self-hostable cloud browsers for AI agents. One API call returns a WebSocket URL to a fresh, isolated Chrome that Playwright, Puppeteer or any Chrome DevTools Protocol client can drive.

**Status:** pre-release. v1 and v2 are complete (sessions, live view, recording, SDKs, CLI, MCP); the dashboard is new. See [docs/STATUS.md](docs/STATUS.md).

Licensed under [Apache-2.0](LICENSE).

- [High-level design](docs/HLD.md)
- [v1 plan](docs/v1-plan.md): the first build, with its exit criteria
- [Decision records](docs/adr/README.md)
- [Threat model](docs/threat-model.md)
- [How the control plane works](docs/control-plane.md)
- [Public API (OpenAPI)](docs/api/openapi.json)
- [Docs for agents](docs/llms.txt): quickstart, sessions, MCP, errors, recipes

## Development

```
nvm use          # Node 24
npm ci
npm run check    # format, lint, type-check, tests
npm run openapi  # regenerate docs/api/openapi.json from the contracts
npm run test:py  # the Python SDK's tests (packages/sdk-py; needs uv, not part of npm test)
```

### The dashboard on your machine

The dashboard (`apps/web`, pages in `packages/dashboard`) talks to the API like any client. To build it without browser nodes, run the API against a seeded database:

```
createdb kestrel_dev
DATABASE_URL=postgresql://kestrel:kestrel@localhost:5432/kestrel_dev npm run db:migrate
DATABASE_URL=postgresql://kestrel:kestrel@localhost:5432/kestrel_dev npm run seed:demo -w @kestrel/api   # prints an admin key
# start the API (see apps/api/src/config.ts for its environment), then:
KESTREL_API_URL=http://127.0.0.1:8080 npm run dev:web    # http://localhost:3000, sign in with the key
```
