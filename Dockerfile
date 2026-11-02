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
# Debian security updates for the OS packages image scanners flag, and no npm /
# corepack in the final image: the app runs with `node` only, and npm's own
# bundled dependencies are a frequent source of scanner findings.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
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
