# syntax=docker/dockerfile:1
#
# MDL Logistics — runtime image for a Linux ARM64 server (plan §5 and §6).
#
# Why this is not the upstream Playwright image
# (mcr.microsoft.com/playwright): upstream only publishes amd64 tags for the
# Node-based images, and the target server here is linux/arm64. So the browser is
# installed here, by Playwright's own CLI, on top of an official multi-arch Node
# image. That is also why `npx playwright install --with-deps chromium` is used
# instead of a pinned Debian package: the browser build must match the Playwright
# version pinned in package.json, and the matching apt dependencies come with it.
#
# Build (on an arm64 machine, or with buildx + qemu elsewhere):
#   docker build --platform linux/arm64 .
#   docker compose build
#
# Only the public npm registry is used: no registry login, no CI-only base image.

FROM node:24-bookworm-slim

# - PLAYWRIGHT_BROWSERS_PATH: a fixed, non-root-readable location for the browser,
#   so the runtime user does not need $HOME/.cache.
# - MDL_HEADLESS: a server has no display. The app resolves this through the env
#   layer; `true` here is the server default, override it to go headed locally.
# - DEBIAN_FRONTEND: keep `apt-get` (run by `playwright install --with-deps`)
#   non-interactive.
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    MDL_HEADLESS=true

WORKDIR /app

# This project runs TypeScript directly through `tsx` (no build step), so
# `tsx`, `typescript` and `playwright` are devDependencies that are also needed at
# runtime. `npm ci` therefore installs them, and the lockfile pins the browser
# version that `npx playwright install` below will match.
COPY package.json package-lock.json ./
RUN npm ci

# Chromium plus its system libraries (libnss3, libatk*, fonts, etc.).
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

# Application source. `.dockerignore` keeps node_modules, artifacts, docs, tests
# and every env/session file out of the image.
COPY --chown=node:node . .

# Writable output (screenshots, traces, run-records) owned by the runtime user, and
# a browser directory the same user can read and execute.
RUN mkdir -p /app/artifacts \
 && chown -R node:node /app/artifacts /ms-playwright

# Never root: Chromium and the app run as the unprivileged `node` user (uid 1000).
USER node

# The UI is loopback-only inside the process (src/ui/server.ts). See
# docker-compose.yml for how that stays loopback on the host.
EXPOSE 4319

CMD ["node", "--import", "tsx", "src/ui/main.ts", "--port", "4319"]
