# The browser runtime image (v1 plan R1-R14): Debian 12, Chrome for Testing pinned by version, a
# virtual display, and `runtimed`, one bundled Node program. Docker's init is PID 1.
#
# Build (from the repository root, after `npm run bundle -w @kestrel/runtimed`):
#   docker build -f runtime/Dockerfile --build-arg CHROME_VERSION=$(cat runtime/CHROME_VERSION) -t kestrel-runtime:dev runtime
#
# The context is `runtime/`, which must contain `runtimed.mjs` (copied there by runtime/build.sh).

# Pinned by digest (R1): debian:bookworm-slim, linux/amd64.
FROM debian:bookworm-slim@sha256:f3034a6ec3c1205360777c4aae76234998866ad18806ae62b63a3f84ccad782b AS base

# Node 24 binary, from the official image pinned by digest, for runtimed only.
FROM node:24-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS node

FROM base
ARG CHROME_VERSION

# Chrome's runtime libraries (from Chrome for Testing's documented dependency list), the virtual
# display, and fonts. `curl` and `unzip` are removed again once Chrome is installed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip xvfb xauth ffmpeg \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 \
      libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 libu2f-udev libvulkan1 \
 && curl -fsSL -o /tmp/chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" \
 && unzip -q /tmp/chrome.zip -d /opt \
 && mv /opt/chrome-linux64 /opt/chrome \
 && rm /tmp/chrome.zip \
 && apt-get purge -y --auto-remove curl unzip \
 && rm -rf /var/lib/apt/lists/* \
 && /opt/chrome/chrome --version

COPY --from=node /usr/local/bin/node /usr/local/bin/node

# /artifacts: the recording volume's mount point (W3). Docker gives a new named volume the image
# directory's owner, so the recorder can write to it; without a volume it stays read-only.
# One unprivileged user for everything inside (R10): nothing here is trusted, so separating users buys nothing.
RUN useradd --uid 10001 --user-group --no-create-home --home-dir /home/kestrel --shell /usr/sbin/nologin kestrel \
 && mkdir -p /opt/runtimed /home/kestrel /profile /artifacts \
 && chown -R 10001:10001 /home/kestrel /profile /artifacts

COPY runtimed.mjs /opt/runtimed/runtimed.mjs

USER 10001:10001
WORKDIR /home/kestrel
ENV HOME=/home/kestrel NODE_ENV=production
# Ports are not published: the agent and gateway reach the container by its address on the internal network (R7).
ENTRYPOINT ["/usr/local/bin/node", "/opt/runtimed/runtimed.mjs"]
