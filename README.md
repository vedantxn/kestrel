# Kestrel

Open-source, self-hostable cloud browsers for AI agents. One API call returns a WebSocket URL to a fresh, isolated Chrome that Playwright, Puppeteer or any Chrome DevTools Protocol client can drive.

**Status:** pre-release. Work package WP0 (foundations) is in progress; nothing runs yet.

- [High-level design](docs/HLD.md)
- [v1 plan](docs/v1-plan.md): the first build, with its exit criteria
- [Decision records](docs/adr/README.md)
- [Threat model](docs/threat-model.md)
- [How the control plane works](docs/control-plane.md)
- [Public API (OpenAPI)](docs/api/openapi.json)

## Development

```
nvm use          # Node 24
npm ci
npm run check    # format, lint, type-check, tests
npm run openapi  # regenerate docs/api/openapi.json from the contracts
npm run test:py  # the Python SDK's tests (packages/sdk-py; needs uv, not part of npm test)
```
