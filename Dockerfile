# syntax=docker/dockerfile:1

# ---- deps: full install (dev deps needed for `nest build`) ----
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/tsconfig.json ./

# Local-storage uploads land here. Ephemeral on Render — use STORAGE_PROVIDER=s3 in production.
RUN mkdir -p uploads && chown node:node uploads

USER node

# Render injects PORT; main.ts reads it (defaults to 8000).
EXPOSE 8000

# Migrations run automatically on boot (migrationsRun: true).
CMD ["node", "-r", "tsconfig-paths/register", "dist/src/main"]
