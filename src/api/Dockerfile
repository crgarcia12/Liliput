# Build context: repo root (for az acr build from .)
# Replicate monorepo structure so tsc rootDir produces correct paths
#
# Base images come from Microsoft Container Registry (MCR) instead of Docker
# Hub to avoid the 100-pull/6h anonymous Docker Hub rate limit on ACR build
# agents. MCR is Azure-hosted and has no anonymous rate limits.

FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm AS deps
WORKDIR /build/src/api
COPY src/api/package.json src/api/package-lock.json* ./
RUN npm ci --omit=dev
# Patch the bundled Copilot SDK CLI to emit a stderr line every time it
# constructs a completion request body. This is the only reliable way to
# observe what reasoning_effort actually goes on the wire — the SDK's
# bundled undici is invisible to globalThis.fetch / node:https wrappers.
COPY src/api/patch-sdk-effort-tracer.cjs /tmp/patch-sdk-effort-tracer.cjs
RUN node /tmp/patch-sdk-effort-tracer.cjs /build/src/api/node_modules/@github/copilot/app.js

FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm AS build
WORKDIR /build/src/api
COPY src/api/package.json src/api/package-lock.json* ./
RUN npm ci
COPY src/api/tsconfig.json ./
COPY src/api/src/ ./src/
COPY src/shared/ /build/src/shared/
RUN npx tsc

# Runner: same base — has git already, just add azure-cli for `az acr build`.
FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV AGENT_WORKSPACE_ROOT=/workspaces

# azure-cli for the agent's `az acr build` flow + kubectl for in-cluster ops
# (debug deploys, read pod logs, exec into dev-env pods). git is already in
# the base image. kubectl auths via the in-cluster SA token automatically.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release apt-transport-https \
 && mkdir -p /etc/apt/keyrings \
 && curl -sLS https://packages.microsoft.com/keys/microsoft.asc \
      | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
      > /etc/apt/sources.list.d/azure-cli.list \
 && curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key \
      | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
 && echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' \
      > /etc/apt/sources.list.d/kubernetes.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends azure-cli kubectl \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspaces \
 && chown -R node:node /workspaces /app

COPY --from=deps  /build/src/api/node_modules ./node_modules
COPY --from=build /build/src/api/dist          ./dist
COPY --from=build /build/src/api/package.json  ./
COPY src/api/preload-effort-tracer.cjs         ./preload-effort-tracer.cjs

# Load the fetch tracer in BOTH the parent process and any node subprocess
# the SDK spawns (subprocess inherits parent env). This is the only way to
# capture reasoning_effort on the wire — the SDK's CLI runs in a child proc.
ENV NODE_OPTIONS="--require /app/preload-effort-tracer.cjs"

USER node
EXPOSE 8080
CMD ["node", "dist/api/src/index.js"]
