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

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=deps /build/src/api/node_modules ./node_modules
COPY --from=build /build/src/api/dist ./dist
COPY --from=build /build/src/api/package.json ./
EXPOSE 8080
CMD ["node", "dist/api/src/index.js"]
