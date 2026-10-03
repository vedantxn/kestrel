# The platform image (v1 plan T16): one image for every Kestrel service, the service chosen by the
# command. Built on the host from the synced tree:
#   docker build -f infra/compose/Dockerfile -t kestrel-platform:dev .
FROM node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7

# iptables for the node agent (Debian 12's default backend is nf_tables, like the host's: experiment V6).
RUN apt-get update \
 && apt-get install -y --no-install-recommends iptables ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
# Install, compile every workspace, then drop what only building needed. `prisma generate` runs on install.
# better-sqlite3 compiles a native module on install, so a toolchain is present for that step only.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci && npm run build && npm prune --omit=dev \
 && apt-get purge -y --auto-remove python3 make g++ && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache

ENV NODE_ENV=production
CMD ["node", "--version"]
