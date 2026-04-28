# Build context: repo root (for az acr build from .)
#
# Base images come from Microsoft Container Registry (MCR) to avoid the
# Docker Hub anonymous pull rate limit. MCR is Azure-hosted, no limits.
FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm AS deps
WORKDIR /app
COPY src/web/package.json src/web/package-lock.json* ./
RUN npm ci

FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src/shared/ /shared/
COPY src/web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM mcr.microsoft.com/devcontainers/javascript-node:20-bookworm AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# bookworm-flavored user creation (devcontainer base already has a `node` user
# at uid 1000, we make a dedicated `nextjs` for the runtime).
RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs --shell /bin/false nextjs
COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
