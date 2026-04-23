# Build context: repo root (for az acr build from .)
FROM node:20-alpine AS deps
WORKDIR /app
COPY src/api/package.json src/api/package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine AS build
WORKDIR /app
COPY src/api/package.json src/api/package-lock.json* ./
RUN npm ci
COPY src/api/tsconfig.json ./
COPY src/api/src/ ./src/
COPY src/shared/ /shared/
RUN npx tsc

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
EXPOSE 8080
CMD ["node", "dist/api/src/index.js"]
