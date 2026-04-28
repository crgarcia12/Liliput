# Build context: repo root (for az acr build from .)
# Replicate monorepo structure so tsc rootDir produces correct paths

FROM node:22-alpine AS deps
WORKDIR /build/src/api
COPY src/api/package.json src/api/package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /build/src/api
COPY src/api/package.json src/api/package-lock.json* ./
RUN npm ci
COPY src/api/tsconfig.json ./
COPY src/api/src/ ./src/
COPY src/shared/ /build/src/shared/
RUN npx tsc

# Runner: debian-slim so we can install git + azure-cli for the agent.
# (Alpine has azure-cli only via pip with heavy build deps.)
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV AGENT_WORKSPACE_ROOT=/workspaces

# git + azure-cli for the agent's clone/commit/push and `az acr build`
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release git apt-transport-https \
 && mkdir -p /etc/apt/keyrings \
 && curl -sLS https://packages.microsoft.com/keys/microsoft.asc \
      | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
      > /etc/apt/sources.list.d/azure-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends azure-cli \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspaces \
 && chown -R node:node /workspaces /app

COPY --from=deps  /build/src/api/node_modules ./node_modules
COPY --from=build /build/src/api/dist          ./dist
COPY --from=build /build/src/api/package.json  ./

# Run as non-root (workload identity needs the SA token mounted, which works
# for any UID; we create /home/node/.azure in the workspaces volume mount).
USER node
EXPOSE 8080
CMD ["node", "dist/api/src/index.js"]
